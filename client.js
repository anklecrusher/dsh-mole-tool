/**
 * Web panel for the Mole integration.
 *
 * Registers one localized `settings.plugins.tab` contribution that renders
 * disk usage, cleanup previews and the app inventory, all read from the Host
 * through the plugin's own same-origin route.
 *
 * Constraints this file respects, from the Harness plugin guidance:
 *   - No Harness Client package is imported (`@deepseek-ai/dsh-client-ui-*`):
 *     those change without notice and a throwing component blanks the slot.
 *     React comes from the browser module table instead.
 *   - Styling uses only `--dsw-alias-*` theme tokens, so light/dark and theme
 *     changes follow the host. Literal colours are reserved for the icon.
 *   - Every registration goes through `ctx.slots.inject(...)`, so it follows
 *     late slot declaration and teardown.
 *
 * @module @local/dsh-mole-tool/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-mole-tool',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Same-origin route registered by the Host half. */
    const RPC = '/plugins/dsh-mole-tool/rpc'
    /** Namespace for the settings contribution. */
    const NS = 'dsh-mole-tool'

    /** Class prefix, so these rules cannot collide with host styles. */
    const P = 'dsh-mole'

    /**
     * Call the Host route.
     * @param action - the action name.
     * @param extra - additional body fields.
     * @returns the parsed response body.
     */
    async function rpc(action, extra = {}) {
      const response = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      })
      const body = await response.json().catch(() => ({ error: 'unreadable-response' }))
      if (!response.ok || body.error) {
        throw new Error(body.detail ?? body.error ?? `request failed (${response.status})`)
      }
      return body
    }

    /**
     * Render a byte count as a human-readable string.
     * @param bytes - the value to format.
     * @returns the formatted string.
     */
    function bytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let n = value
      let i = 0
      while (n >= 1024 && i < units.length - 1) {
        n /= 1024
        i += 1
      }
      return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`
    }

    /** Stylesheet, rendered as an element so unmounting removes it. */
    function Styles() {
      return h('style', null, `
.${P}-root { display: flex; flex-direction: column; gap: 16px; padding: 4px 0 8px; font-size: 13px; }
.${P}-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.${P}-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.${P}-title { font-weight: 600; color: var(--dsw-alias-text-l1); }
.${P}-sub { color: var(--dsw-alias-text-l3); font-size: 12px; margin-top: 2px; }
.${P}-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.${P}-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.${P}-label { color: var(--dsw-alias-text-l2); }
.${P}-value { color: var(--dsw-alias-text-l1); font-variant-numeric: tabular-nums; }
.${P}-bar { height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-3); overflow: hidden; }
.${P}-bar > i { display: block; height: 100%; background: var(--dsw-alias-text-l3); }
.${P}-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.${P}-tile { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 10px 12px; background: var(--dsw-alias-bg-layer-2); }
.${P}-tile b { display: block; font-size: 18px; color: var(--dsw-alias-text-l1); font-variant-numeric: tabular-nums; }
.${P}-tile span { color: var(--dsw-alias-text-l3); font-size: 12px; }
.${P}-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-text-l1); border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
.${P}-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-3); }
.${P}-btn:disabled { opacity: .55; cursor: default; }
.${P}-btn-primary { background: var(--dsw-alias-text-l1); color: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-text-l1); }
.${P}-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.${P}-list { display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow-y: auto; }
.${P}-item { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.${P}-item:last-child { border-bottom: none; }
.${P}-size { color: var(--dsw-alias-text-l3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.${P}-note { color: var(--dsw-alias-text-l3); font-size: 12px; }
.${P}-err { color: var(--dsw-alias-text-l1); background: var(--dsw-alias-bg-mask-2); border-radius: 8px; padding: 8px 10px; font-size: 12px; }
.${P}-ok { color: var(--dsw-alias-text-l3); font-size: 12px; }
`)
    }

    /**
     * The settings tab component.
     * @param props - slot props, including `locale`.
     */
    function MoleSettingsCard(props) {
      const locale = props?.locale
      const [lang, setLang] = React.useState(() => (locale?.getSnapshot?.()?.active?.startsWith('en') ? 'en' : 'zh'))
      const [info, setInfo] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [preview, setPreview] = React.useState(null)
      const [inventory, setInventory] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [message, setMessage] = React.useState('')

      React.useEffect(() => {
        if (typeof locale?.subscribe !== 'function') return undefined
        return locale.subscribe(() => {
          setLang(locale.getSnapshot?.()?.active?.startsWith('en') ? 'en' : 'zh')
        })
      }, [locale])

      const zh = lang === 'zh'
      const t = (en, cn) => (zh ? cn : en)

      /** Run one panel action, guarding against overlapping requests. */
      const run = React.useCallback(async (key, fn) => {
        setBusy(key)
        setError('')
        setMessage('')
        try {
          return await fn()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
          return undefined
        } finally {
          setBusy('')
        }
      }, [])

      const loadInfo = () => run('info', async () => setInfo(await rpc('info')))
      const loadStatus = () => run('status', async () => {
        const body = await rpc('status')
        setStatus(body.snapshot)
      })
      const loadPreview = () => run('preview', async () => {
        const body = await rpc('cleanPreview')
        setPreview(body.preview)
      })
      const loadInventory = () => run('inventory', async () => {
        const body = await rpc('inventory')
        setInventory(body.inventory)
      })
      const openScreen = (screen) => run(screen, async () => {
        await rpc('open', { screen })
        setMessage(
          screen === 'uninstall'
            ? t('The Mole uninstaller opened in a separate window.', 'Mole 卸载器已在独立窗口中打开。')
            : t('The Mole disk analyzer opened in a separate window.', 'Mole 磁盘分析器已在独立窗口中打开。'),
        )
      })

      // Load the cheap diagnostics once, on first mount.
      React.useEffect(() => {
        loadInfo()
        loadStatus()
      }, [])

      const hardware = status?.hardware ?? {}
      const memory = status?.memory ?? {}
      const disks = status?.disks ?? []

      return h(React.Fragment, null,
        h(Styles),
        h('div', { className: `${P}-root` },

          error ? h('div', { className: `${P}-err` }, error) : null,
          message ? h('div', { className: `${P}-ok` }, message) : null,

          // ---- Machine status -------------------------------------------------
          h('div', { className: `${P}-card` },
            h('div', { className: `${P}-head` },
              h('div', null,
                h('div', { className: `${P}-title` }, t('System status', '系统状态')),
                h('div', { className: `${P}-sub` },
                  status
                    ? `${status.host ?? ''} · ${hardware.os_version ?? ''} · ${hardware.cpu_model ?? ''}`
                    : t('Not loaded yet', '尚未加载')),
              ),
              h('button', {
                className: `${P}-btn`, disabled: busy === 'status', onClick: loadStatus,
              }, busy === 'status' ? t('Loading…', '加载中…') : t('Refresh', '刷新')),
            ),
            h('div', { className: `${P}-body` },
              h('div', { className: `${P}-grid` },
                h('div', { className: `${P}-tile` },
                  h('b', null, status?.health_score ?? '—'),
                  h('span', null, t('Health score', '健康分')),
                ),
                h('div', { className: `${P}-tile` },
                  h('b', null, status?.cpu?.usage !== undefined ? `${Math.round(status.cpu.usage)}%` : '—'),
                  h('span', null, t('CPU', 'CPU 占用')),
                ),
                h('div', { className: `${P}-tile` },
                  h('b', null, memory.used_percent !== undefined ? `${Math.round(memory.used_percent)}%` : '—'),
                  h('span', null, `${t('Memory', '内存')} ${bytes(memory.used)} / ${bytes(memory.total)}`),
                ),
                h('div', { className: `${P}-tile` },
                  h('b', null, status?.uptime ?? '—'),
                  h('span', null, t('Uptime', '运行时长')),
                ),
              ),
              ...disks.map((disk) => h('div', { key: disk.mount },
                h('div', { className: `${P}-row` },
                  h('span', { className: `${P}-label` }, `${t('Disk', '磁盘')} ${disk.mount} ${disk.fstype ?? ''}`),
                  h('span', { className: `${P}-value` },
                    `${bytes(disk.used)} / ${bytes(disk.total)} (${Math.round(disk.used_percent ?? 0)}%)`),
                ),
                h('div', { className: `${P}-bar` },
                  h('i', { style: { width: `${Math.min(100, disk.used_percent ?? 0)}%` } })),
              )),
            ),
          ),

          // ---- Cleanup preview ------------------------------------------------
          h('div', { className: `${P}-card` },
            h('div', { className: `${P}-head` },
              h('div', null,
                h('div', { className: `${P}-title` }, t('Cleanup preview', '清理预览')),
                h('div', { className: `${P}-sub` },
                  preview
                    ? `${preview.potentialSpace ?? '—'} · ${preview.itemCount ?? '—'} ${t('items', '项')}`
                    : t('Runs `mo clean --dry-run`; deletes nothing.', '执行 `mo clean --dry-run`，不会删除任何文件。')),
              ),
              h('button', {
                className: `${P}-btn`, disabled: busy === 'preview', onClick: loadPreview,
              }, busy === 'preview' ? t('Scanning…', '扫描中…') : t('Scan', '扫描')),
            ),
            preview
              ? h('div', { className: `${P}-body` },
                  h('div', { className: `${P}-list` },
                    ...(preview.categories ?? []).map((cat, index) => h('div', {
                      key: `${cat.category}-${index}`, className: `${P}-item`,
                    },
                      h('span', null, cat.category),
                      h('span', { className: `${P}-size` },
                        `${cat.items.reduce((sum, e) => sum + e.items, 0)} · ${cat.items.map((e) => e.size.replace(/\s*dry$/i, '')).join(', ')}`),
                    )),
                  ),
                  h('div', { className: `${P}-note` },
                    t(
                      `Free space now: ${preview.freeSpace ?? '—'}. Review with the mole_clean tool, then run it with execute=true and approve.`,
                      `当前可用空间：${preview.freeSpace ?? '—'}。先用 mole_clean 工具复核，再以 execute=true 执行并确认。`,
                    ),
                  ),
                  preview.listFile
                    ? h('div', { className: `${P}-note` }, `${t('Full path list', '完整路径清单')}: ${preview.listFile}`)
                    : null,
                )
              : null,
          ),

          // ---- Installed applications ----------------------------------------
          h('div', { className: `${P}-card` },
            h('div', { className: `${P}-head` },
              h('div', null,
                h('div', { className: `${P}-title` }, t('Installed applications', '已安装应用')),
                h('div', { className: `${P}-sub` },
                  inventory
                    ? `${inventory.count ?? 0} ${t('applications', '个应用')}`
                    : t('From the Mole uninstaller inventory, largest first.', '来自 Mole 卸载器的清单，按体积降序。')),
              ),
              h('button', {
                className: `${P}-btn`, disabled: busy === 'inventory', onClick: loadInventory,
              }, busy === 'inventory' ? t('Loading…', '加载中…') : t('Load', '加载')),
            ),
            inventory
              ? h('div', { className: `${P}-body` },
                  h('div', { className: `${P}-list` },
                    ...(inventory.apps ?? []).slice(0, 60).map((app, index) => h('div', {
                      key: `${app.name}-${index}`, className: `${P}-item`,
                    },
                      h('span', null, app.name),
                      h('span', { className: `${P}-size` }, app.size ?? '—'),
                    )),
                  ),
                )
              : null,
          ),

          // ---- Interactive tools ---------------------------------------------
          h('div', { className: `${P}-card` },
            h('div', { className: `${P}-head` },
              h('div', null,
                h('div', { className: `${P}-title` }, t('Interactive Mole tools', 'Mole 交互工具')),
                h('div', { className: `${P}-sub` },
                  t(
                    'These are full-screen terminal tools; they open in their own window.',
                    '这些是全屏终端工具，会在独立窗口中打开。',
                  )),
              ),
            ),
            h('div', { className: `${P}-body` },
              h('div', { className: `${P}-actions` },
                h('button', {
                  className: `${P}-btn`, disabled: busy === 'uninstall', onClick: () => openScreen('uninstall'),
                }, t('Open uninstaller', '打开卸载器')),
                h('button', {
                  className: `${P}-btn`, disabled: busy === 'analyze', onClick: () => openScreen('analyze'),
                }, t('Open disk analyzer', '打开磁盘分析器')),
              ),
            ),
          ),

          // ---- Installation ---------------------------------------------------
          h('div', { className: `${P}-card` },
            h('div', { className: `${P}-head` },
              h('div', null,
                h('div', { className: `${P}-title` }, t('Mole installation', 'Mole 安装信息')),
                h('div', { className: `${P}-sub` },
                  info ? (info.ok ? t('CLI available', 'CLI 可用') : t('CLI not available', 'CLI 不可用'))
                    : t('Checking…', '检查中…')),
              ),
              h('button', {
                className: `${P}-btn`, disabled: busy === 'info', onClick: loadInfo,
              }, t('Recheck', '重新检查')),
            ),
            info
              ? h('div', { className: `${P}-body` },
                  h('div', { className: `${P}-row` },
                    h('span', { className: `${P}-label` }, t('Executable', '可执行文件')),
                    h('span', { className: `${P}-value` }, info.executable),
                  ),
                  h('div', { className: `${P}-row` },
                    h('span', { className: `${P}-label` }, t('Resolved by', '解析方式')),
                    h('span', { className: `${P}-value` }, info.resolvedBy),
                  ),
                  h('div', { className: `${P}-row` },
                    h('span', { className: `${P}-label` }, t('Output encoding', '输出编码')),
                    h('span', { className: `${P}-value` }, info.encoding),
                  ),
                  h('div', { className: `${P}-row` },
                    h('span', { className: `${P}-label` }, t('Whitelist', '白名单')),
                    h('span', { className: `${P}-value` }, info.paths?.whitelist ?? '—'),
                  ),
                  info.detail
                    ? h('pre', { className: `${P}-note`, style: { margin: 0, whiteSpace: 'pre-wrap' } }, info.detail)
                    : null,
                )
              : null,
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.get('locale')
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: NS,
          order: 40,
          label: () => (locale?.getSnapshot?.()?.active?.startsWith('en') ? 'Mole' : 'Mole 清理'),
          locale,
        }, MoleSettingsCard))
      },
    }
  },
})
