/**
 * Mole (mo) integration for the DeepSeek Harness.
 *
 * Mole's free GPL-3.0 CLI is driven as an external process — no Mole source is
 * vendored, copied or linked, so the GPL imposes no obligation on this plugin.
 * What is paid is only the separate mole.fit native GUI, which this plugin does
 * not use or depend on.
 *
 * This module owns three things:
 *   1. the tool registrations (delegated to `lib/tools.js`),
 *   2. the Web panel's same-origin JSON routes,
 *   3. the approval wiring for the one destructive operation.
 *
 * @module @local/dsh-mole-tool
 */

import { createService } from './lib/service.js'
import { createTools } from './lib/tools.js'

/** Same-origin JSON route the settings panel reads through. */
const ROUTE = '/plugins/dsh-mole-tool/rpc'

/** Request-body cap for the RPC route; every payload here is tiny. */
const MAX_BODY_BYTES = 8 * 1024

/**
 * Reject cross-origin callers.
 *
 * The panel is served from the same origin as the harness, so a request that
 * carries a different `Origin` is not from our UI.
 *
 * @param req - the Node request.
 * @returns true when the request is same-origin or carries no Origin.
 */
function sameOrigin(req) {
  const { origin, host } = req.headers
  if (origin !== undefined && host !== undefined && origin !== `http://${host}` && origin !== `https://${host}`) {
    return false
  }
  return true
}

/**
 * Write a JSON response.
 * @param res - the Node response.
 * @param status - HTTP status code.
 * @param payload - JSON-serialisable body.
 */
function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Read and parse a JSON request body within the size cap.
 * @param req - the Node request.
 * @returns the parsed body.
 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.length === 0 ? {} : JSON.parse(text)
}

/**
 * Plugin configuration.
 *
 * Deliberately a plain validator rather than a schemastery schema: this bundle
 * is symlinked into the profile from `E:`, and Node resolves a symlinked module
 * to its real path, so a bare `@deepseek-ai/schemastery` import would be
 * resolved from `E:\GitHubWorkspace\...` and fail with ERR_MODULE_NOT_FOUND.
 * The reference implementation on this machine (`dsh-gitbash-tool`) takes the
 * same approach for the same reason.
 *
 * Unknown keys are reported so a typo in `cordis.patch.yml` is visible rather
 * than silently ignored.
 *
 * @param raw - the row's `config` object.
 * @param logger - logger used for diagnostics.
 * @returns the normalised configuration.
 */
function normalizeConfig(raw, logger) {
  const source = raw ?? {}
  const known = new Set(['molePath', 'outputEncoding', 'timeoutMs'])
  for (const key of Object.keys(source)) {
    if (!known.has(key)) logger?.warn?.(`mole: unknown config key "${key}" ignored`)
  }
  const out = {}
  if (typeof source.molePath === 'string' && source.molePath.length > 0) out.molePath = source.molePath
  if (typeof source.outputEncoding === 'string' && source.outputEncoding.length > 0) {
    out.outputEncoding = source.outputEncoding
  }
  if (typeof source.timeoutMs === 'number' && Number.isFinite(source.timeoutMs) && source.timeoutMs > 0) {
    out.timeoutMs = source.timeoutMs
  }
  return out
}

/**
 * Plugin entry point.
 *
 * @param ctx - the plugin context (requires the `tools` service).
 * @param config - validated plugin config.
 */
export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const service = createService(normalizeConfig(config, logger), logger)

  // The approval seam is optional: without it, the destructive tool fails
  // closed rather than deleting anything. Resolve it lazily so the plugin
  // still loads in a profile that does not compose it.
  const requestApproval = async (request) => {
    const approval = ctx.get?.('approval')
    if (!approval || typeof approval.request !== 'function') return 'unavailable'
    return approval.request(request)
  }

  for (const tool of createTools(service, { requestApproval, logger })) {
    ctx.tools.register(tool)
  }

  // Web panel data route. Registered on the plugin's own context so unloading
  // the bundle removes it.
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: 'origin-rejected' })
        if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })

        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return json(res, 400, { error: 'invalid-request', detail: error.message })
        }

        const action = body?.action
        try {
          switch (action) {
            case 'info': {
              const version = await service.version()
              return json(res, 200, {
                ok: version.ok,
                executable: service.launcher.path,
                resolvedBy: service.launcher.source,
                encoding: service.config.encoding,
                detail: version.ok ? version.text : version.stderr,
                paths: service.paths,
              })
            }
            case 'status':
              return json(res, 200, { ok: true, snapshot: await service.status() })
            case 'cleanPreview':
              return json(res, 200, { ok: true, preview: await service.cleanPreview() })
            case 'optimizePreview':
              return json(res, 200, { ok: true, preview: await service.optimizePreview() })
            case 'purgePreview':
              return json(res, 200, { ok: true, preview: await service.purgePreview() })
            case 'inventory': {
              const inventory = await service.inventory()
              return json(res, 200, { ok: true, inventory })
            }
            case 'open': {
              // Interactive TUIs are opened for the human; the panel cannot
              // complete them, and neither can the agent.
              const screen = body?.screen
              if (screen !== 'uninstall' && screen !== 'analyze') {
                return json(res, 400, { error: 'unknown-screen' })
              }
              const opened = service.openInteractive(screen, { path: body?.path })
              return json(res, 200, { ok: true, opened })
            }
            default:
              return json(res, 400, { error: 'unknown-action', action })
          }
        } catch (error) {
          logger?.warn?.(`mole: panel action "${action}" failed: ${error.message}`)
          return json(res, 500, { error: 'action-failed', action, detail: error.message })
        }
      },
    }),
    'dsh-mole-tool: panel rpc route',
  )

  logger?.info?.(`mole: tools registered (launcher ${service.launcher.path} via ${service.launcher.source})`)
}

/** Package identity, for diagnostics. */
export const name = 'dsh-mole-tool'
