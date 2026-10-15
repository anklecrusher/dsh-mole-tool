/**
 * Mole (`mo`) process layer.
 *
 * Design notes that come from measuring the real CLI on this machine
 * (Mole CLI 1.34.0, Windows 11, zh-CN, PowerShell 5.1):
 *
 * 1. **Encoding.** `mo.exe` is a launcher that forwards to `mole.ps1`, which
 *    Windows PowerShell runs. PowerShell writes the *console code page*, not
 *    UTF-8, so on a zh-CN machine `mo` emits GBK bytes. Decoding that as UTF-8
 *    produced `ʹ�á�1��������` instead of `使用“1”个参数调用`. Node's
 *    `TextDecoder('gbk')` decodes it correctly (verified, full-ICU build).
 *    `status --json` happens to be pure ASCII, but the human-readable commands
 *    are not, so decoding is not optional.
 *
 * 2. **No TTY.** `uninstall` and `analyze` are interactive TUIs
 *    (`[Console]::ReadKey` / bubbletea). With stdin and stdout redirected they
 *    do not degrade to a scriptable mode — `uninstall` aborts with
 *    "应用程序没有控制台…无法读取输入" and `analyze` draws a full-screen UI that
 *    never returns. Those two are therefore *not* driven through pipes; they
 *    are launched in a real terminal window for the human (see
 *    {@link openInTerminal}). Everything else runs headless.
 *
 * 3. **`clean` deletes without asking.** Unlike `uninstall`/`purge`, which end
 *    in a `Read-Host "Continue? (y/N)"` prompt, `clean` has no confirmation
 *    step at all — it scans and deletes in one pass. That is why the tool
 *    layer defaults to `--dry-run` and requires an explicit opt-in to execute.
 *
 * @module @local/dsh-mole-tool/lib/mole
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

/** Default deadline for a `mo` invocation. Scans are slow; 2 minutes is normal. */
export const DEFAULT_TIMEOUT_MS = 120_000
/** Hard ceiling for a caller-supplied deadline. */
export const MAX_TIMEOUT_MS = 600_000
/** Per-stream capture cap. `clean --dry-run` on a full disk can be verbose. */
const MAX_OUTPUT_BYTES = 512 * 1024

/**
 * Mole's own state directory, relative to the user profile.
 * Holds `clean-list.txt` (dry-run export) and the whitelist.
 */
const MOLE_CONFIG_DIR = '.config/mole'
/** Mole's cache directory, relative to the user profile. Holds the app scan. */
const MOLE_CACHE_DIR = '.cache/mole'

/**
 * Absolute `mo` locations to probe, most specific first.
 *
 * Scoop creates a *shim* rather than a symlink for `bin` entries, and the shim
 * lives in `scoop\shims`. The `apps\...\current` path is checked too because a
 * shim can be missing after a partial install.
 *
 * @returns candidate absolute paths that may hold the Mole launcher.
 */
function candidateMolePaths() {
  const out = []
  const { LOCALAPPDATA, USERPROFILE, HOME, ProgramFiles, PROGRAMFILES } = process.env
  const home = USERPROFILE || HOME
  if (home) {
    out.push(join(home, 'scoop', 'shims', 'mo.exe'))
    out.push(join(home, 'scoop', 'apps', 'mole', 'current', 'mo.exe'))
  }
  if (LOCALAPPDATA) {
    // Script install target documented by the Windows branch README.
    out.push(join(LOCALAPPDATA, 'Programs', 'mole-cli', 'mo.exe'))
  }
  const pf = ProgramFiles || PROGRAMFILES
  if (pf) out.push(join(pf, 'Mole', 'mo.exe'))
  return out
}

/**
 * Resolve the Mole launcher once, preferring explicit configuration.
 *
 * @param configured - optional absolute path from the plugin config.
 * @returns the executable to spawn plus how it was chosen.
 */
export function resolveMole(configured) {
  if (typeof configured === 'string' && configured.length > 0) {
    return { path: configured, source: 'config.molePath' }
  }
  for (const candidate of candidateMolePaths()) {
    if (existsSync(candidate)) return { path: candidate, source: 'probe' }
  }
  // Last resort: let the OS resolve `mo` through PATH. If Mole is absent the
  // spawn fails with ENOENT and the tool reports an actionable message.
  return { path: 'mo', source: 'PATH' }
}

/**
 * Build a decoder for Mole's output.
 *
 * Mole writes the console code page. The configured encoding is tried first;
 * if it yields replacement characters while a UTF-8 decode is clean, UTF-8
 * wins — that keeps the plugin correct on a machine whose code page is already
 * UTF-8 (code page 65001), without needing configuration.
 *
 * @param buffer - raw bytes from the child process.
 * @param preferred - configured encoding name.
 * @returns decoded text.
 */
function decodeOutput(buffer, preferred) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  if (preferred === 'utf-8') return utf8
  let legacy
  try {
    legacy = new TextDecoder(preferred, { fatal: false }).decode(buffer)
  } catch {
    // Unknown encoding name: UTF-8 is the only remaining interpretation.
    return utf8
  }
  // A successful UTF-8 decode of genuinely UTF-8 bytes contains no U+FFFD.
  // When it does, the bytes were code-page encoded and the legacy decode is
  // the trustworthy one.
  const utf8Clean = !utf8.includes('\uFFFD')
  const legacyClean = !legacy.includes('\uFFFD')
  if (utf8Clean && !legacyClean) return utf8
  return legacy
}

/**
 * Run the Mole CLI and capture its output.
 *
 * stdin is always closed immediately. Every command driven through this
 * function is one that completes without input; a command that tried to prompt
 * would receive EOF and fail rather than hang forever.
 *
 * @param mole - resolved launcher from {@link resolveMole}.
 * @param args - CLI arguments, passed as separate argv entries.
 * @param options - encoding, deadline, working directory and abort signal.
 * @returns the captured result.
 */
export function runMole(mole, args, options = {}) {
  const {
    encoding = 'gbk',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cwd = undefined,
    signal = undefined,
  } = options

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(mole.path, args, {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }

    const outChunks = []
    const errChunks = []
    let outBytes = 0
    let errBytes = 0
    let truncated = false
    let timedOut = false
    let settled = false

    /** Kill the whole tree: `mo.exe` spawns PowerShell, which spawns more. */
    const terminate = (reason) => {
      if (settled) return
      if (reason === 'timeout') timedOut = true
      try {
        // On Windows a bare kill() leaves grandchildren alive, so use taskkill.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }

    const timer = setTimeout(() => terminate('timeout'), timeoutMs)
    const onAbort = () => terminate('abort')
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length
      if (outBytes <= MAX_OUTPUT_BYTES) outChunks.push(chunk)
      else truncated = true
    })
    child.stderr.on('data', (chunk) => {
      errBytes += chunk.length
      if (errBytes <= MAX_OUTPUT_BYTES) errChunks.push(chunk)
      else truncated = true
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      const hint =
        error.code === 'ENOENT'
          ? ` Mole was not found at "${mole.path}" (${mole.source}). Install it with \`scoop install mole\`, or set config.molePath in the bundle patch.`
          : ''
      reject(new Error(`mole: failed to start the CLI: ${error.message}.${hint}`))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve({
        exitCode: code ?? null,
        timedOut,
        truncated,
        stdout: decodeOutput(Buffer.concat(outChunks), encoding),
        stderr: decodeOutput(Buffer.concat(errChunks), encoding),
        argv: args,
      })
    })

    // No command driven here needs input; EOF makes any accidental prompt fail
    // fast instead of blocking until the deadline.
    child.stdin.end()
  })
}

/** Strip ANSI SGR sequences and cursor control from Mole's coloured output. */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '')
}

/**
 * Parse the summary block that `clean`, `optimize` and `purge` print between
 * their `====` rules.
 *
 * @param text - decoded CLI output.
 * @returns the summary lines, trimmed.
 */
function summaryBlock(text) {
  const clean = stripAnsi(text)
  const match = clean.match(/={10,}\r?\n([\s\S]*?)\r?\n={10,}/)
  if (!match) return []
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Remove the leading bullet glyph from a Mole output line.
 *
 * Mole prefixes section headers with `➤` (U+27A4) and entries with `→`
 * (U+2192). Neither survives intact: the launcher writes the console code page
 * (see {@link decodeOutput}), and `➤` has no GBK mapping, so PowerShell emits a
 * literal `?` for it. Parsing must therefore never key off the glyph itself —
 * this helper drops whatever bullet is present and the caller classifies by
 * indentation instead.
 *
 * @param line - one output line, already stripped of ANSI.
 * @returns the line without its leading bullet.
 */
function dropBullet(line) {
  return line.replace(/^\s*[^\w\s("'[]+\s*/, '').trim()
}

/**
 * Parse `mo clean --dry-run`.
 *
 * The human summary gives totals; the per-category lines above it give the
 * breakdown the agent needs to reason about what is actually being removed.
 *
 * Classification is by indentation, not by icon: an unindented line opens a
 * category, an indented line is one of its entries. Measured output shape:
 *
 * ```
 * ? User essentials
 *   → User temp files (>7d old) (46 items, 5.4MB dry)
 * ```
 *
 * @param text - decoded CLI output.
 * @returns totals plus per-category rows.
 */
export function parseClean(text) {
  const clean = stripAnsi(text)
  const categories = []
  let current = null
  for (const raw of clean.split(/\r?\n/)) {
    const indented = /^\s{2,}\S/.test(raw)
    const line = dropBullet(raw)
    if (line.length === 0 || /^=+$/.test(line)) continue
    // The system banner ("Microsoft Windows 11 … | Free space: …") is not a
    // category; it is reported separately from the summary.
    if (!indented && line.includes('|') && /free space/i.test(line)) continue
    const entry = line.match(/^(.+?)\s*\((\d+)\s*items?,\s*([^)]+)\)\s*$/)
    if (indented) {
      if (entry && current) {
        current.items.push({ name: entry[1].trim(), items: Number(entry[2]), size: entry[3].trim() })
      }
      continue
    }
    if (line.length > 0 && !/^(clean|dry run)/i.test(line)) {
      current = { category: line, items: [] }
      categories.push(current)
    }
  }

  const summary = summaryBlock(text)
  const potential = clean.match(/Potential space:\s*([0-9.]+\s*[KMGT]?B)/i)
  const items = clean.match(/Items:\s*(\d+)/i)
  const cats = clean.match(/Categories:\s*(\d+)/i)
  const free = clean.match(/Free space:\s*([0-9.]+\s*[KMGT]?B)/i)
  const listFile = clean.match(/Detailed file list:\s*(.+?)\s*$/im)

  return {
    potentialSpace: potential ? potential[1] : null,
    itemCount: items ? Number(items[1]) : null,
    categoryCount: cats ? Number(cats[1]) : null,
    freeSpace: free ? free[1] : null,
    listFile: listFile ? listFile[1].trim() : null,
    categories: categories.filter((c) => c.items.length > 0),
    summary,
  }
}

/**
 * Parse `mo optimize` / `mo optimize --dry-run`.
 *
 * Same indentation-based classification as {@link parseClean}, for the same
 * reason: the `➤` bullet degrades to `?` under the console code page.
 * Measured output shape:
 *
 * ```
 * ? Disk Optimization
 *   ● Requires administrator privileges
 * ? DNS Cache
 *   → Would flush DNS cache
 * ```
 *
 * @param text - decoded CLI output.
 * @returns section rows plus the summary.
 */
export function parseOptimize(text) {
  const clean = stripAnsi(text)
  const sections = []
  let current = null
  for (const raw of clean.split(/\r?\n/)) {
    const indented = /^\s{2,}\S/.test(raw)
    const line = dropBullet(raw)
    if (line.length === 0 || /^=+$/.test(line)) continue
    // Banner: "? System  11.5/15.8GB RAM | 187/204GB Disk | Uptime 0.2d"
    if (!indented && line.includes('|')) continue
    if (!indented && !/^(optimize|dry run)/i.test(line)) {
      current = { section: line, notes: [] }
      sections.push(current)
      continue
    }
    if (indented && current) current.notes.push(line)
  }
  return { sections: sections.filter((s) => s.notes.length > 0), summary: summaryBlock(text) }
}

/**
 * Parse `mo purge --dry-run`.
 *
 * @param text - decoded CLI output.
 * @returns summary lines and whether anything was found.
 */
export function parsePurge(text) {
  const clean = stripAnsi(text)
  const empty = /No cleanable artifacts found/i.test(clean)
  return { empty, summary: summaryBlock(text), raw: clean.trim() }
}

/**
 * Read Mole's installed-application inventory.
 *
 * `mo uninstall` cannot run headlessly, but it maintains
 * `~/.cache/mole/app_scan_cache_v3.json`, which is a complete inventory of
 * installed applications with sizes. Reading it gives the agent the useful
 * half of `uninstall` — "what is installed and how large is it" — without a
 * terminal. The file is written by PowerShell's `Set-Content`, so it is
 * code-page encoded, not UTF-8 (verified: 174 KB, GBK).
 *
 * @param options - profile directory and preferred encoding.
 * @returns the parsed inventory, or a diagnostic explaining its absence.
 */
export async function readAppInventory(options = {}) {
  const { encoding = 'gbk', maxAgeHours = 168 } = options
  const home = process.env.USERPROFILE || process.env.HOME
  if (!home) return { available: false, reason: 'no-user-profile', apps: [] }
  const file = join(home, MOLE_CACHE_DIR, 'app_scan_cache_v3.json')
  let buffer
  try {
    buffer = await fsp.readFile(file)
  } catch {
    return {
      available: false,
      reason: 'no-cache',
      file,
      apps: [],
      hint: 'Run `mo uninstall --dry-run` once in a terminal to build the inventory.',
    }
  }
  const text = decodeOutput(buffer, encoding)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { available: false, reason: 'unparsable', file, apps: [], detail: error.message }
  }
  const list = Array.isArray(parsed) ? parsed : []
  const stat = await fsp.stat(file).catch(() => null)
  const ageHours = stat ? (Date.now() - stat.mtimeMs) / 3_600_000 : null
  return {
    available: true,
    file,
    stale: ageHours !== null && ageHours > maxAgeHours,
    ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    count: list.length,
    apps: list.map((app) => ({
      name: app?.Name ?? null,
      publisher: app?.Publisher ?? null,
      version: app?.Version ?? null,
      size: app?.SizeHuman ?? null,
      sizeKB: typeof app?.SizeKB === 'number' ? app.SizeKB : null,
      installLocation: app?.InstallLocation ?? null,
      source: app?.Source ?? null,
    })),
  }
}

/**
 * Read the file list a `clean --dry-run` run exported.
 *
 * @param file - absolute path from the parsed summary.
 * @param encoding - preferred encoding for the exported file.
 * @returns the exported paths, or a diagnostic.
 */
export async function readCleanList(file, encoding = 'gbk') {
  if (typeof file !== 'string' || file.length === 0) {
    return { available: false, paths: [], reason: 'no-path' }
  }
  let buffer
  try {
    buffer = await fsp.readFile(file)
  } catch {
    return { available: false, paths: [], reason: 'unreadable', file }
  }
  const text = decodeOutput(buffer, encoding)
  const paths = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  return { available: true, file, count: paths.length, paths }
}

/**
 * Launch a Mole command in a real, visible terminal window.
 *
 * `uninstall` and `analyze` are full-screen TUIs that cannot be driven over
 * pipes, so the plugin hands them to the human instead of pretending to
 * automate them. Windows Terminal is preferred when present; otherwise a
 * plain console window is opened.
 *
 * @param mole - resolved launcher.
 * @param args - CLI arguments for the interactive command.
 * @param options - working directory for the new window.
 * @returns how the window was opened.
 */
export function openInTerminal(mole, args, options = {}) {
  const { cwd = undefined } = options
  const quote = (value) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value)
  const commandLine = [quote(mole.path), ...args.map(quote)].join(' ')

  const wt = join(
    process.env.LOCALAPPDATA ?? '',
    'Microsoft',
    'WindowsApps',
    'wt.exe',
  )
  const useWt = process.env.LOCALAPPDATA ? existsSync(wt) : false

  // `start` is a cmd builtin, so it must be run through cmd.exe. The empty
  // first argument is the window title; omitting it makes `start` treat a
  // quoted command as the title.
  const cmdArgs = useWt
    ? ['/c', 'start', '', 'wt.exe', '-w', '0', 'new-tab', '--title', 'Mole', ...args.length ? [mole.path, ...args] : [mole.path]]
    : ['/c', 'start', '', 'cmd.exe', '/k', commandLine]

  const child = spawn('cmd.exe', cmdArgs, {
    cwd,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  return { opened: true, via: useWt ? 'windows-terminal' : 'console', command: commandLine }
}

/** Absolute paths the tools may need to report. */
export function molePaths() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return {
    config: join(home, MOLE_CONFIG_DIR),
    whitelist: join(home, MOLE_CONFIG_DIR, 'whitelist.txt'),
    cleanList: join(home, MOLE_CONFIG_DIR, 'clean-list.txt'),
    cache: join(home, MOLE_CACHE_DIR),
  }
}
