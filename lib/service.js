/**
 * Mole service: one place that runs `mo` and shapes its answers.
 *
 * Both the agent tools and the Web settings panel read through this module, so
 * a scan triggered from the panel and a scan triggered by the model produce
 * byte-identical results. Keeping the process handling here also keeps the
 * approval and dry-run policy in a single auditable place rather than
 * duplicated per tool.
 *
 * @module @local/dsh-mole-tool/lib/service
 */

import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  molePaths,
  openInTerminal,
  parseClean,
  parseOptimize,
  parsePurge,
  readAppInventory,
  readCleanList,
  resolveMole,
  runMole,
  stripAnsi,
} from './mole.js'

/**
 * Build the service bound to one resolved launcher and configuration.
 *
 * @param config - validated plugin configuration.
 * @param logger - optional Cordis logger for diagnostics.
 * @returns the service object consumed by tools and routes.
 */
export function createService(config, logger) {
  const mole = resolveMole(config?.molePath)
  const encoding = config?.outputEncoding ?? 'gbk'
  const timeoutMs = Math.min(config?.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const paths = molePaths()

  /**
   * Run a read-only Mole command.
   * @param args - CLI arguments.
   * @param options - per-call deadline override.
   * @returns the raw result.
   */
  async function read(args, options = {}) {
    return runMole(mole, args, {
      encoding,
      timeoutMs: options.timeoutMs ?? timeoutMs,
      signal: options.signal,
    })
  }

  return {
    /** Resolved launcher and how it was found. */
    launcher: mole,
    /** Absolute Mole state paths. */
    paths,
    /** Effective configuration, for diagnostics. */
    config: { encoding, timeoutMs },

    /**
     * Report whether Mole is usable, without running a scan.
     * @returns version and platform details.
     */
    async version() {
      const result = await read(['--version'], { timeoutMs: 30_000 })
      return {
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        text: stripAnsi(result.stdout).trim(),
        stderr: stripAnsi(result.stderr).trim(),
      }
    },

    /**
     * Live system snapshot (`mo status --json`).
     *
     * This command emits pure ASCII JSON, so it needs no parsing heuristics and
     * is safe to call often. The full snapshot is large; the caller picks what
     * to surface.
     *
     * @returns the parsed snapshot.
     */
    async status() {
      const result = await read(['status', '--json'], { timeoutMs: 60_000 })
      if (result.exitCode !== 0) {
        throw new Error(
          `mole status failed (exit ${result.exitCode}): ${stripAnsi(result.stderr).trim() || 'no stderr'}`,
        )
      }
      try {
        return JSON.parse(result.stdout)
      } catch (error) {
        throw new Error(`mole status returned unparsable JSON: ${error.message}`)
      }
    },

    /**
     * Preview a cleanup without deleting anything (`mo clean --dry-run`).
     *
     * @returns totals, per-category breakdown, and the exported file list.
     */
    async cleanPreview() {
      const result = await read(['clean', '--dry-run'], { timeoutMs: Math.max(timeoutMs, 180_000) })
      const parsed = parseClean(result.stdout)
      const list = await readCleanList(parsed.listFile, encoding)
      return {
        exitCode: result.exitCode,
        ...parsed,
        exported: { available: list.available, count: list.count ?? 0, file: list.file ?? null },
        // Paths are returned so a human can review them, but the tool layer
        // caps how many reach the model's context.
        paths: list.paths ?? [],
      }
    },

    /**
     * Execute a cleanup.
     *
     * Mole's `clean` has **no confirmation step** — unlike `uninstall` and
     * `purge`, which end in a `Read-Host "Continue? (y/N)"`, `clean` scans and
     * deletes in one pass, permanently (only `mo analyze` uses the Recycle
     * Bin). The `dryRun` flag therefore defaults to `true` here and the tool
     * layer only passes `false` after an explicit opt-in.
     *
     * @param options - whether to actually delete, and whether to include
     *   system-level targets (requires an elevated shell).
     * @returns the run summary.
     */
    async clean({ dryRun = true, system = false, gameMedia = false } = {}) {
      const args = ['clean']
      if (dryRun) args.push('--dry-run')
      if (system) args.push('--system')
      if (gameMedia) args.push('--game-media')
      const result = await read(args, { timeoutMs: Math.max(timeoutMs, 300_000) })
      const parsed = parseClean(result.stdout)
      return {
        dryRun,
        exitCode: result.exitCode,
        ...parsed,
        output: stripAnsi(result.stdout).trim(),
        stderr: stripAnsi(result.stderr).trim(),
      }
    },

    /**
     * Preview system maintenance (`mo optimize --dry-run`).
     *
     * Always a dry run: `optimize` without the flag performs real system
     * changes (DNS flush, icon cache rebuild, SSD retrim) and, when elevated,
     * blocks on a `Read-Host` prompt asking about System File Checker — which
     * would hang a headless call.
     *
     * @returns the maintenance report.
     */
    async optimizePreview() {
      const result = await read(['optimize', '--dry-run'], { timeoutMs: Math.max(timeoutMs, 180_000) })
      const parsed = parseOptimize(result.stdout)
      return {
        exitCode: result.exitCode,
        ...parsed,
        output: stripAnsi(result.stdout).trim(),
      }
    },

    /**
     * Preview project-artifact cleanup (`mo purge --dry-run`).
     *
     * @returns what would be removed from build directories.
     */
    async purgePreview() {
      const result = await read(['purge', '--dry-run'], { timeoutMs: Math.max(timeoutMs, 180_000) })
      const parsed = parsePurge(result.stdout)
      return {
        exitCode: result.exitCode,
        ...parsed,
        output: stripAnsi(result.stdout).trim(),
      }
    },

    /**
     * Installed-application inventory with sizes.
     *
     * Sourced from the cache `mo uninstall` maintains, because the uninstaller
     * itself is an interactive TUI that cannot run headlessly.
     *
     * @returns the inventory.
     */
    async inventory() {
      return readAppInventory({ encoding })
    },

    /**
     * Open an interactive Mole screen in a real terminal window.
     *
     * `uninstall` and `analyze` are full-screen TUIs. With stdin and stdout
     * redirected they do not fall back to a scriptable mode: `uninstall`
     * aborts with "应用程序没有控制台…无法读取输入", and `analyze` (bubbletea)
     * draws forever and never exits. Rather than pretend to automate them, the
     * plugin opens them for the human and says so.
     *
     * @param screen - which interactive command to open.
     * @param options - optional path for `analyze`.
     * @returns how the window was opened.
     */
    openInteractive(screen, options = {}) {
      if (screen !== 'uninstall' && screen !== 'analyze') {
        throw new Error(`mole: "${screen}" is not an interactive Mole screen.`)
      }
      const args = screen === 'analyze' && options.path ? ['analyze', options.path] : [screen]
      const result = openInTerminal(mole, args, { cwd: options.cwd })
      logger?.info?.(`mole: opened interactive ${screen} via ${result.via}`)
      return { screen, ...result }
    },
  }
}
