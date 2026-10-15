/**
 * Agent tools over the Mole CLI.
 *
 * Policy decisions encoded here, and why:
 *
 * - **`mole_clean` defaults to a preview.** Mole's `clean` has no confirmation
 *   step of its own (unlike `uninstall`/`purge`, which prompt `Continue? (y/N)`)
 *   and deletes permanently rather than to the Recycle Bin. A model that can
 *   delete files on a single unverified call is a foot-gun, so `execute` must be
 *   set explicitly and the call is routed through the approval seam.
 * - **`mole_uninstall` and `mole_analyze` are user-only.** They are full-screen
 *   TUIs that cannot be driven over pipes, and an uninstall destroys installed
 *   software. Per the Harness plugin guidance, an action that grants or confirms
 *   authority stays user-only, so these tools open the real terminal window and
 *   never pretend to automate the choice.
 * - **Read-only tools never prompt.** `status`, `inventory`, the previews and
 *   `version` are safe to call freely, so they stay cheap.
 *
 * @module @local/dsh-mole-tool/lib/tools
 */

/** Cap on how many paths a preview returns, to protect the model's context. */
const MAX_PREVIEW_PATHS = 40
/** Cap on inventory rows returned per call. */
const MAX_INVENTORY_ROWS = 40

/**
 * Render a byte count as a human-readable string.
 * @param bytes - the value to format.
 * @returns the formatted string, or null when the input is not a number.
 */
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return null
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)}${units[unit]}`
}

/**
 * Build the tool definitions.
 *
 * @param service - the Mole service from `createService`.
 * @param deps - approval seam and logger, injected by the plugin entry.
 * @returns the tool definitions to register.
 */
export function createTools(service, deps = {}) {
  const { requestApproval, logger } = deps

  /**
   * Ask the human before a destructive cleanup.
   *
   * Fails closed: when no approval seam is composed, or the answerer is
   * unavailable, the deletion does not happen. The approval service returns
   * `'allowed-once'` as its only grant, and requires an open turn.
   *
   * @param args - tool arguments, for the reason text.
   * @param exec - the tool execution context (carries agent and call id).
   * @returns the approval outcome.
   */
  async function approveClean(args, exec) {
    if (typeof requestApproval !== 'function') {
      return { outcome: 'unavailable', reason: 'no approval service composed' }
    }
    const scope = args.system ? 'including system-level targets' : 'user-level targets only'
    try {
      const outcome = await requestApproval({
        agent: exec?.agent,
        toolName: 'mole_clean',
        callId: exec?.callId,
        signal: exec?.signal,
        reason:
          `Run \`mo clean\` and permanently delete the files Mole selected (${scope}). `
          + 'Mole deletes without a confirmation prompt and does not use the Recycle Bin.',
        displayReason: {
          en: `Permanently delete the files Mole selected (${scope}).`,
          zh: `永久删除 Mole 选中的文件（${args.system ? '含系统级目标' : '仅用户级目标'}）。`,
        },
      })
      return { outcome: outcome === 'allowed-once' ? 'allowed' : outcome }
    } catch (error) {
      // A thrown request means the decision could not be recorded; that is a
      // failure to obtain authority, so it must not fall through to deletion.
      return { outcome: 'unavailable', reason: error.message }
    }
  }

  return [
    {
      name: 'mole_status',
      description:
        'Live system health snapshot from the Mole CLI (`mo status --json`): health score, CPU (total and '
        + 'per-core), memory, disks, disk I/O, network interfaces and rates, battery, and the top processes by '
        + 'CPU. Read-only, safe to call repeatedly, and the cheapest way to answer "how is this machine doing".',
      parameters: {
        type: 'object',
        properties: {
          includeProcesses: {
            type: 'boolean',
            description: 'Include the top-process list (default true). Set false for a smaller result.',
          },
          includeNetworkHistory: {
            type: 'boolean',
            description: 'Include the network throughput history arrays (default false).',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            collectedAt: { type: 'string', description: 'When Mole sampled the metrics.' },
            host: { type: 'string', description: 'Machine name.' },
            os: { type: 'string', description: 'Operating system version.' },
            hardware: { type: 'string', description: 'CPU model, RAM and disk size summary.' },
            uptime: { type: 'string', description: 'Human-readable uptime.' },
            healthScore: {
              oneOf: [{ type: 'integer' }, { type: 'null' }],
              description: 'Mole health score, 0-100.',
            },
            healthMessage: { type: 'string', description: 'Mole verdict for the health score.' },
            cpuUsagePercent: {
              oneOf: [{ type: 'number' }, { type: 'null' }],
              description: 'Total CPU utilisation percentage.',
            },
            memoryUsedPercent: {
              oneOf: [{ type: 'number' }, { type: 'null' }],
              description: 'Memory utilisation percentage.',
            },
            memorySummary: { type: 'string', description: 'Used/total memory, human readable.' },
            disks: {
              type: 'array',
              description: 'Per-volume usage.',
              items: {
                type: 'object',
                properties: {
                  mount: { type: 'string', description: 'Mount point.' },
                  usedPercent: { type: 'number', description: 'Percentage used.' },
                  summary: { type: 'string', description: 'Used/total, human readable.' },
                },
                required: ['mount', 'usedPercent', 'summary'],
                additionalProperties: false,
              },
            },
            network: {
              type: 'array',
              description: 'Network interfaces and their addresses.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Interface name.' },
                  ip: { type: 'string', description: 'Interface address.' },
                  rxMbs: { type: 'number', description: 'Current receive rate, MB/s.' },
                  txMbs: { type: 'number', description: 'Current transmit rate, MB/s.' },
                },
                required: ['name', 'ip', 'rxMbs', 'txMbs'],
                additionalProperties: false,
              },
            },
            battery: {
              oneOf: [{ type: 'string' }, { type: 'null' }],
              description: 'Battery summary, or null on a machine without one.',
            },
            topProcesses: {
              type: 'array',
              description: 'Top processes by CPU.',
              items: {
                type: 'object',
                properties: {
                  pid: { type: 'integer', description: 'Process id.' },
                  name: { type: 'string', description: 'Process name.' },
                  cpuPercent: { type: 'number', description: 'CPU percentage.' },
                  memory: { type: 'string', description: 'Resident memory, human readable.' },
                },
                required: ['pid', 'name', 'cpuPercent', 'memory'],
                additionalProperties: false,
              },
            },
          },
          required: ['collectedAt', 'host', 'os', 'hardware', 'uptime', 'healthScore', 'healthMessage', 'cpuUsagePercent', 'memoryUsedPercent', 'memorySummary', 'disks', 'network', 'battery', 'topProcesses'],
          additionalProperties: false,
        },
        render(_args, value) {
          const lines = [
            `${value.host} · ${value.os}`,
            `${value.hardware}`,
            `Health ${value.healthScore ?? '?'}/100 (${value.healthMessage}) · uptime ${value.uptime}`,
            `CPU ${value.cpuUsagePercent ?? '?'}% · Memory ${value.memoryUsedPercent ?? '?'}% (${value.memorySummary})`,
          ]
          for (const disk of value.disks) lines.push(`Disk ${disk.mount} ${disk.usedPercent}% used (${disk.summary})`)
          if (value.battery) lines.push(`Battery ${value.battery}`)
          if (value.topProcesses.length > 0) {
            lines.push('Top processes:')
            for (const proc of value.topProcesses) {
              lines.push(`  ${proc.name} (pid ${proc.pid}) ${proc.cpuPercent.toFixed(1)}% CPU · ${proc.memory}`)
            }
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall() {
        return { card: 'generic', title: 'mo status' }
      },
      async execute(args) {
        const snapshot = await service.status()
        const hardware = snapshot.hardware ?? {}
        const memory = snapshot.memory ?? {}
        const includeProcesses = args.includeProcesses !== false
        return {
          collectedAt: String(snapshot.collected_at ?? ''),
          host: String(snapshot.host ?? ''),
          os: String(hardware.os_version ?? snapshot.platform ?? ''),
          hardware: [hardware.cpu_model, hardware.total_ram, hardware.disk_size].filter(Boolean).join(' · '),
          uptime: String(snapshot.uptime ?? ''),
          healthScore: typeof snapshot.health_score === 'number' ? snapshot.health_score : null,
          healthMessage: String(snapshot.health_score_msg ?? ''),
          cpuUsagePercent: typeof snapshot.cpu?.usage === 'number' ? snapshot.cpu.usage : null,
          memoryUsedPercent: typeof memory.used_percent === 'number' ? Math.round(memory.used_percent * 10) / 10 : null,
          memorySummary: `${formatBytes(memory.used) ?? '?'} / ${formatBytes(memory.total) ?? '?'}`,
          disks: (snapshot.disks ?? []).map((disk) => ({
            mount: String(disk.mount ?? ''),
            usedPercent: Math.round((disk.used_percent ?? 0) * 10) / 10,
            summary: `${formatBytes(disk.used) ?? '?'} / ${formatBytes(disk.total) ?? '?'}`,
          })),
          network: (snapshot.network ?? []).map((iface) => ({
            name: String(iface.name ?? ''),
            ip: String(iface.ip ?? ''),
            rxMbs: Number(iface.rx_rate_mbs ?? 0),
            txMbs: Number(iface.tx_rate_mbs ?? 0),
          })),
          battery: snapshot.batteries?.length
            ? `${snapshot.batteries[0].percent}% ${snapshot.batteries[0].status}`.trim()
            : null,
          topProcesses: includeProcesses
            ? (snapshot.top_processes ?? []).slice(0, 10).map((proc) => ({
                pid: Number(proc.pid ?? 0),
                name: String(proc.name ?? ''),
                cpuPercent: Number(proc.cpu ?? 0),
                memory: formatBytes(proc.memory_bytes) ?? '',
              }))
            : [],
        }
      },
    },

    {
      name: 'mole_clean_preview',
      description:
        'Preview a Mole deep cleanup (`mo clean --dry-run`) without deleting anything. Returns the reclaimable '
        + 'total, a per-category breakdown (user temp, browser caches, developer tools, application caches, …), '
        + 'and the path list Mole exported. Always run this before mole_clean.',
      parameters: {
        type: 'object',
        properties: {
          includePaths: {
            type: 'boolean',
            description: `Include up to ${MAX_PREVIEW_PATHS} example paths (default false).`,
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            potentialSpace: { type: 'string', description: 'Total reclaimable size.' },
            itemCount: {
              oneOf: [{ type: 'integer' }, { type: 'null' }],
              description: 'Number of files Mole would remove.',
            },
            freeSpace: { type: 'string', description: 'Current free space on the system drive.' },
            listFile: { type: 'string', description: 'Where Mole exported the full path list.' },
            categories: {
              type: 'array',
              description: 'Reclaimable space grouped by Mole category.',
              items: {
                type: 'object',
                properties: {
                  category: { type: 'string', description: 'Category name.' },
                  items: { type: 'integer', description: 'File count in this category.' },
                  size: { type: 'string', description: 'Reclaimable size in this category.' },
                },
                required: ['category', 'items', 'size'],
                additionalProperties: false,
              },
            },
            paths: {
              type: 'array',
              description: 'Example paths Mole would remove.',
              items: { type: 'string', description: 'An absolute path.' },
            },
          },
          required: ['potentialSpace', 'itemCount', 'freeSpace', 'listFile', 'categories', 'paths'],
          additionalProperties: false,
        },
        render(_args, value) {
          const lines = [
            `Reclaimable: ${value.potentialSpace ?? 'unknown'} across ${value.itemCount ?? '?'} items`,
            `Free space now: ${value.freeSpace ?? 'unknown'}`,
          ]
          for (const cat of value.categories) {
            lines.push(`  ${cat.category}: ${cat.items} items, ${cat.size}`)
          }
          if (value.listFile) lines.push(`Full path list: ${value.listFile}`)
          if (value.paths.length > 0) {
            lines.push(`Example paths:\n${value.paths.map((p) => `  ${p}`).join('\n')}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall() {
        return { card: 'generic', title: 'mo clean --dry-run' }
      },
      async execute(args) {
        const preview = await service.cleanPreview()
        return {
          potentialSpace: preview.potentialSpace ?? 'unknown',
          itemCount: preview.itemCount,
          freeSpace: preview.freeSpace ?? 'unknown',
          listFile: preview.listFile ?? '',
          categories: preview.categories.map((cat) => {
            // Keep each entry's size attached to its name: a flat list of
            // numbers detached from what they measure tells the model nothing.
            const detail = cat.items
              .map((entry) => `${entry.name} ${entry.size.replace(/\s*dry$/i, '')}`)
              .join('; ')
            return {
              category: cat.category,
              items: cat.items.reduce((sum, entry) => sum + entry.items, 0),
              size: detail,
            }
          }),
          paths: args.includePaths ? preview.paths.slice(0, MAX_PREVIEW_PATHS) : [],
        }
      },
    },

    {
      name: 'mole_clean',
      description:
        'Run a Mole cleanup (`mo clean`). Defaults to a dry run. Setting execute=true permanently deletes the '
        + 'files Mole selected — Mole does not use the Recycle Bin and asks for no confirmation of its own, so '
        + 'this call is sent to the user for approval and fails closed when no approver is available. Always call '
        + 'mole_clean_preview first and show the user what will go.',
      parameters: {
        type: 'object',
        properties: {
          execute: {
            type: 'boolean',
            description: 'Set true to actually delete. Omitted or false runs a preview only.',
          },
          system: {
            type: 'boolean',
            description: 'Also include system-level targets. Requires an elevated shell; skipped otherwise.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            executed: { type: 'boolean', description: 'True when files were actually deleted.' },
            approval: {
              type: 'string',
              description: 'Approval outcome: allowed, rejected, cancelled, unavailable, or not-required.',
            },
            potentialSpace: { type: 'string', description: 'Reclaimable or reclaimed size.' },
            itemCount: {
              oneOf: [{ type: 'integer' }, { type: 'null' }],
              description: 'Number of files involved.',
            },
            freeSpace: { type: 'string', description: 'Free space after the run.' },
            summary: { type: 'string', description: 'Mole\'s own summary block.' },
          },
          required: ['executed', 'approval', 'potentialSpace', 'itemCount', 'freeSpace', 'summary'],
          additionalProperties: false,
        },
        render(_args, value) {
          // A refused cleanup never ran, so do not print placeholder totals
          // that read like real measurements ("not run across ? items").
          if (!value.executed && value.approval !== 'not-required') {
            return [{ type: 'text', text: value.summary }]
          }
          const verb = value.executed ? 'Cleaned' : 'Preview only — nothing deleted'
          return [{
            type: 'text',
            text: `${verb}\n${value.potentialSpace} across ${value.itemCount ?? '?'} items\nFree space: ${value.freeSpace}\n${value.summary}`,
          }]
        },
      },
      presentCall(args) {
        return { card: 'terminal', title: args.execute ? 'mo clean' : 'mo clean --dry-run' }
      },
      async execute(args, exec) {
        if (!args.execute) {
          const preview = await service.clean({ dryRun: true, system: Boolean(args.system) })
          return {
            executed: false,
            approval: 'not-required',
            potentialSpace: preview.potentialSpace ?? 'unknown',
            itemCount: preview.itemCount,
            freeSpace: preview.freeSpace ?? 'unknown',
            summary: preview.summary.join('\n'),
          }
        }

        const decision = await approveClean(args, exec)
        if (decision.outcome !== 'allowed') {
          return {
            executed: false,
            approval: decision.outcome,
            potentialSpace: 'not run',
            itemCount: null,
            freeSpace: 'not run',
            summary: `Cleanup was not executed: approval ${decision.outcome}${decision.reason ? ` (${decision.reason})` : ''}.`,
          }
        }

        const result = await service.clean({ dryRun: false, system: Boolean(args.system) })
        logger?.info?.(`mole: clean executed, exit ${result.exitCode}`)
        return {
          executed: true,
          approval: 'allowed',
          potentialSpace: result.potentialSpace ?? 'unknown',
          itemCount: result.itemCount,
          freeSpace: result.freeSpace ?? 'unknown',
          summary: result.summary.join('\n'),
        }
      },
    },

    {
      name: 'mole_optimize_preview',
      description:
        'Report what Mole system maintenance would do (`mo optimize --dry-run`): DNS cache flush, icon and '
        + 'QuickLook cache refresh, disk optimization and health, startup programs, Windows Update status. '
        + 'Read-only — the plugin never runs the real optimize, because it performs system changes and can block '
        + 'on an interactive prompt when elevated.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            sections: {
              type: 'array',
              description: 'Maintenance areas and what Mole would do in each.',
              items: {
                type: 'object',
                properties: {
                  section: { type: 'string', description: 'Area name.' },
                  notes: { type: 'array', description: 'Findings for this area.', items: { type: 'string', description: 'One finding.' } },
                },
                required: ['section', 'notes'],
                additionalProperties: false,
              },
            },
            summary: { type: 'string', description: 'Mole\'s summary block.' },
          },
          required: ['sections', 'summary'],
          additionalProperties: false,
        },
        render(_args, value) {
          const lines = []
          for (const section of value.sections) {
            lines.push(`${section.section}:`)
            for (const note of section.notes) lines.push(`  ${note}`)
          }
          if (value.summary) lines.push(value.summary)
          return [{ type: 'text', text: lines.join('\n') || 'Nothing to report.' }]
        },
      },
      presentCall() {
        return { card: 'generic', title: 'mo optimize --dry-run' }
      },
      async execute() {
        const result = await service.optimizePreview()
        return { sections: result.sections, summary: result.summary.join('\n') }
      },
    },

    {
      name: 'mole_purge_preview',
      description:
        'Preview project build-artifact cleanup (`mo purge --dry-run`): node_modules, target, dist, build and '
        + 'similar directories under the configured project roots. Read-only.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            found: { type: 'boolean', description: 'False when Mole found no cleanable artifacts.' },
            summary: { type: 'string', description: 'Mole\'s report.' },
          },
          required: ['found', 'summary'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{ type: 'text', text: value.summary || (value.found ? 'Artifacts found.' : 'No cleanable artifacts found.') }]
        },
      },
      presentCall() {
        return { card: 'generic', title: 'mo purge --dry-run' }
      },
      async execute() {
        const result = await service.purgePreview()
        return { found: !result.empty, summary: result.summary.join('\n') || result.raw }
      },
    },

    {
      name: 'mole_inventory',
      description:
        'List installed applications with their sizes, from the inventory the Mole uninstaller maintains. '
        + 'Largest first. Read-only. Use this to find what is consuming disk; removing software itself needs '
        + 'mole_uninstall, which opens the interactive uninstaller for the user.',
      parameters: {
        type: 'object',
        properties: {
          minSizeGB: {
            type: 'number',
            description: 'Only include applications at least this large, in GB.',
          },
          limit: {
            type: 'integer',
            description: `Maximum rows to return (default ${MAX_INVENTORY_ROWS}).`,
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            available: { type: 'boolean', description: 'Whether the inventory could be read.' },
            stale: { type: 'boolean', description: 'True when the cached inventory is older than a week.' },
            ageHours: {
              oneOf: [{ type: 'number' }, { type: 'null' }],
              description: 'Age of the cached inventory in hours.',
            },
            totalCount: { type: 'integer', description: 'Applications in the inventory before filtering.' },
            apps: {
              type: 'array',
              description: 'Matching applications, largest first.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Application name.' },
                  publisher: { type: 'string', description: 'Publisher, when known.' },
                  version: { type: 'string', description: 'Version, when known.' },
                  size: { type: 'string', description: 'Installed size.' },
                  installLocation: { type: 'string', description: 'Install path, when known.' },
                },
                required: ['name', 'publisher', 'version', 'size', 'installLocation'],
                additionalProperties: false,
              },
            },
            note: { type: 'string', description: 'A diagnostic when the inventory is unavailable.' },
          },
          required: ['available', 'stale', 'ageHours', 'totalCount', 'apps', 'note'],
          additionalProperties: false,
        },
        render(_args, value) {
          if (!value.available) return [{ type: 'text', text: value.note || 'Application inventory unavailable.' }]
          const lines = [`${value.totalCount} applications${value.stale ? ' (inventory is stale)' : ''}`]
          for (const app of value.apps) {
            lines.push(`  ${app.size.padStart(9)}  ${app.name}${app.publisher ? ` — ${app.publisher}` : ''}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall() {
        return { card: 'generic', title: 'mo inventory' }
      },
      async execute(args) {
        const inventory = await service.inventory()
        if (!inventory.available) {
          return {
            available: false,
            stale: false,
            ageHours: null,
            totalCount: 0,
            apps: [],
            note: inventory.hint
              ?? `Application inventory unavailable (${inventory.reason}).`,
          }
        }
        const minKB = typeof args.minSizeGB === 'number' ? args.minSizeGB * 1024 * 1024 : 0
        const limit = Math.min(Math.max(args.limit ?? MAX_INVENTORY_ROWS, 1), 200)
        const filtered = inventory.apps.filter((app) => (app.sizeKB ?? 0) >= minKB)
        return {
          available: true,
          stale: Boolean(inventory.stale),
          ageHours: inventory.ageHours ?? null,
          totalCount: inventory.count ?? filtered.length,
          apps: filtered.slice(0, limit).map((app) => ({
            name: app.name ?? '(unknown)',
            publisher: app.publisher ?? '',
            version: app.version ?? '',
            size: app.size ?? '',
            installLocation: app.installLocation ?? '',
          })),
          note: '',
        }
      },
    },

    {
      name: 'mole_uninstall',
      description:
        'Open Mole\'s interactive uninstaller in a real terminal window so the user can pick applications and '
        + 'remove them with their leftovers. This tool does NOT remove anything itself: `mo uninstall` is a '
        + 'full-screen TUI that cannot run headlessly, and choosing software to delete is the user\'s decision. '
        + 'Use mole_inventory to find candidates first, then tell the user the window is open.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            opened: { type: 'boolean', description: 'True when the terminal window was launched.' },
            via: { type: 'string', description: 'How it was opened: windows-terminal or console.' },
            note: { type: 'string', description: 'What the user must do next.' },
          },
          required: ['opened', 'via', 'note'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{ type: 'text', text: `Opened the Mole uninstaller in a ${value.via} window. ${value.note}` }]
        },
      },
      presentCall() {
        return { card: 'terminal', title: 'mo uninstall' }
      },
      async execute() {
        const result = service.openInteractive('uninstall')
        return {
          opened: result.opened,
          via: result.via,
          note: 'The user selects applications and confirms in that window; nothing is removed until they do.',
        }
      },
    },

    {
      name: 'mole_analyze',
      description:
        'Open Mole\'s interactive disk-usage explorer in a real terminal window. `mo analyze` is a full-screen '
        + 'TUI with no machine-readable output mode, so it cannot return a result to the model; it is opened for '
        + 'the user to navigate. For a result the model can read, use mole_inventory or the storage-analyzer skill.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory or drive to scan. Omit for the drives overview.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            opened: { type: 'boolean', description: 'True when the terminal window was launched.' },
            via: { type: 'string', description: 'How it was opened: windows-terminal or console.' },
            path: { type: 'string', description: 'The path that was opened, or empty for the overview.' },
            note: { type: 'string', description: 'What the user must do next.' },
          },
          required: ['opened', 'via', 'path', 'note'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{
            type: 'text',
            text: `Opened the Mole disk analyzer in a ${value.via} window${value.path ? ` for ${value.path}` : ''}. ${value.note}`,
          }]
        },
      },
      presentCall(args) {
        return { card: 'terminal', title: `mo analyze${args.path ? ` ${args.path}` : ''}` }
      },
      async execute(args) {
        const result = service.openInteractive('analyze', { path: args.path })
        return {
          opened: result.opened,
          via: result.via,
          path: args.path ?? '',
          note: 'Navigate with the arrow keys in that window; deletions there go to the Recycle Bin.',
        }
      },
    },

    {
      name: 'mole_info',
      description:
        'Report Mole\'s installation state: the resolved launcher path, how it was found, the CLI version and '
        + 'platform, and where Mole keeps its whitelist and path list. Use this first when another mole_* tool '
        + 'reports that Mole is missing or behaving unexpectedly.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', description: 'True when the CLI answered.' },
            executable: { type: 'string', description: 'Resolved launcher path.' },
            resolvedBy: { type: 'string', description: 'How the launcher was found.' },
            version: { type: 'string', description: 'Mole CLI version line.' },
            outputEncoding: { type: 'string', description: 'Encoding used to decode Mole output.' },
            whitelistFile: { type: 'string', description: 'Protected-paths file.' },
            cleanListFile: { type: 'string', description: 'Dry-run path export.' },
            detail: { type: 'string', description: 'Full version output or the failure reason.' },
          },
          required: ['ok', 'executable', 'resolvedBy', 'version', 'outputEncoding', 'whitelistFile', 'cleanListFile', 'detail'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{
            type: 'text',
            text: [
              `Mole ${value.ok ? 'is available' : 'is NOT available'}`,
              `Executable: ${value.executable} (found via ${value.resolvedBy})`,
              `Decoding: ${value.outputEncoding}`,
              `Whitelist: ${value.whitelistFile}`,
              `Path list: ${value.cleanListFile}`,
              value.detail,
            ].join('\n'),
          }]
        },
      },
      presentCall() {
        return { card: 'generic', title: 'mo --version' }
      },
      async execute() {
        const result = await service.version()
        const versionLine = result.text.split(/\r?\n/).find((line) => /mole version/i.test(line)) ?? ''
        return {
          ok: result.ok,
          executable: service.launcher.path,
          resolvedBy: service.launcher.source,
          version: versionLine,
          outputEncoding: service.config.encoding,
          whitelistFile: service.paths.whitelist,
          cleanListFile: service.paths.cleanList,
          detail: result.ok ? result.text : (result.stderr || 'The CLI did not answer.'),
        }
      },
    },
  ]
}
