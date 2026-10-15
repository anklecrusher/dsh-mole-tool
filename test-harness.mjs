/**
 * Offline test harness for @local/dsh-mole-tool.
 *
 * Runs the plugin's real code paths against the real Mole CLI, with a fake
 * Cordis context standing in for the harness. No DSH process is needed, so a
 * regression here is caught before it reaches the live profile.
 *
 * Usage: node test-harness.mjs
 */

import assert from 'node:assert/strict'
import { createService } from './lib/service.js'
import { createTools } from './lib/tools.js'
import { apply } from './index.js'

const results = []
let failures = 0

/**
 * Run one named check.
 * @param name - the check's label.
 * @param fn - the async body; throwing fails the check.
 */
async function check(name, fn) {
  try {
    await fn()
    results.push(`  PASS  ${name}`)
  } catch (error) {
    failures += 1
    results.push(`  FAIL  ${name}\n        ${error.message}`)
  }
}

/**
 * Build a minimal Cordis-like context that records registrations.
 *
 * `inject` is modelled faithfully: Cordis throws
 * `cannot get property "webServer" without inject` when a service is read
 * without declaring it, and that exact failure took the plugin's activation
 * down on a live harness run. Reproducing it here means the regression cannot
 * come back unnoticed.
 *
 * @param options - overrides for the approval and webServer seams.
 * @returns the fake context plus its captured registrations.
 */
function fakeContext(options = {}) {
  const captured = { tools: [], routes: [], effects: [], logs: [], injected: [] }
  const hasWebServer = options.webServer !== false
  const ctx = {
    logger: {
      info: (m) => captured.logs.push(['info', m]),
      warn: (m) => captured.logs.push(['warn', m]),
    },
    tools: { register: (tool) => captured.tools.push(tool) },
    effect: (fn) => { captured.effects.push(fn); return fn() },
    get: (name) => (name === 'approval' ? options.approval : undefined),
    inject: (services, callback) => {
      captured.injected.push(services)
      // Defer like the real loader: the callback runs only once every declared
      // service is present, and never runs when one is missing.
      if (services.includes('webServer') && !hasWebServer) return
      const child = {
        webServer: {
          register: (route) => { captured.routes.push(route); return () => {} },
        },
        effect: (fn) => { captured.effects.push(fn); return fn() },
      }
      callback(child)
    },
    // A bare property read must fail the way Cordis fails it, so a future edit
    // that drops the inject declaration is caught here rather than in the app.
    get webServer() {
      throw new Error('cannot get property "webServer" without inject')
    },
  }
  return { ctx, captured }
}

/**
 * Invoke a captured route handler with a fake request.
 * @param route - the registered route.
 * @param body - JSON request body.
 * @param method - HTTP method.
 * @returns the parsed response.
 */
async function callRoute(route, body, method = 'POST') {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  const req = {
    method,
    headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield payload },
  }
  let status = 0
  let text = ''
  const res = {
    writeHead: (code) => { status = code },
    end: (chunk) => { text = chunk ?? '' },
  }
  await route.handler(req, res)
  return { status, body: text.length > 0 ? JSON.parse(text) : null }
}

// ---------------------------------------------------------------------------
// Service layer
// ---------------------------------------------------------------------------

const service = createService({}, { info() {}, warn() {} })

await check('resolveMole finds the launcher', () => {
  assert.ok(service.launcher.path.length > 0, 'no launcher path')
  assert.ok(['probe', 'config.molePath', 'PATH'].includes(service.launcher.source))
})

await check('version reports the CLI is usable', async () => {
  const v = await service.version()
  assert.equal(v.ok, true, `CLI not usable: ${v.stderr}`)
  assert.match(v.text, /Mole version/i)
})

await check('status returns a parsed snapshot', async () => {
  const snapshot = await service.status()
  assert.ok(typeof snapshot.health_score === 'number', 'missing health_score')
  assert.ok(Array.isArray(snapshot.disks) && snapshot.disks.length > 0, 'missing disks')
  assert.ok(typeof snapshot.memory?.used_percent === 'number', 'missing memory')
})

await check('cleanPreview parses categories and totals', async () => {
  const preview = await service.cleanPreview()
  assert.equal(preview.exitCode, 0)
  assert.ok(preview.categories.length > 0, 'no categories parsed')
  assert.ok(preview.potentialSpace, 'no potential space parsed')
  for (const cat of preview.categories) {
    assert.ok(cat.category.length > 0, 'empty category name')
    assert.ok(cat.items.length > 0, `category "${cat.category}" has no entries`)
  }
})

await check('cleanPreview reads back the exported path list', async () => {
  const preview = await service.cleanPreview()
  assert.equal(preview.exported.available, true, 'export file unreadable')
  assert.ok(preview.exported.count > 0, 'exported list is empty')
  assert.ok(preview.paths.length > 0, 'no paths returned')
  assert.ok(preview.paths.every((p) => /^[A-Za-z]:\\/.test(p)), 'a path is not absolute')
})

await check('optimizePreview parses sections', async () => {
  const preview = await service.optimizePreview()
  assert.equal(preview.exitCode, 0)
  assert.ok(preview.sections.length > 0, 'no sections parsed')
  for (const section of preview.sections) {
    assert.ok(section.section.length > 0, 'empty section name')
  }
})

await check('purgePreview completes', async () => {
  const preview = await service.purgePreview()
  assert.equal(preview.exitCode, 0)
  assert.equal(typeof preview.empty, 'boolean')
})

await check('inventory returns applications with sizes', async () => {
  const inventory = await service.inventory()
  assert.equal(inventory.available, true, `inventory unavailable: ${inventory.reason}`)
  assert.ok(inventory.count > 0, 'no applications')
  const first = inventory.apps[0]
  assert.ok(first.name, 'first app has no name')
  assert.ok(first.size, 'first app has no size')
})

await check('clean({dryRun:true}) deletes nothing', async () => {
  const result = await service.clean({ dryRun: true })
  assert.equal(result.dryRun, true)
  assert.match(result.output, /Dry Run Mode/i, 'not a dry run')
})

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const toolset = createTools(service, {
  requestApproval: async () => 'allowed-once',
  logger: { info() {}, warn() {} },
})
const byName = Object.fromEntries(toolset.map((t) => [t.name, t]))

await check('all expected tools are registered', () => {
  const expected = [
    'mole_status', 'mole_clean_preview', 'mole_clean', 'mole_optimize_preview',
    'mole_purge_preview', 'mole_inventory', 'mole_uninstall', 'mole_analyze', 'mole_info',
  ]
  for (const name of expected) assert.ok(byName[name], `missing tool ${name}`)
})

await check('every tool declares a valid schema and description', () => {
  for (const tool of toolset) {
    assert.equal(tool.parameters.type, 'object', `${tool.name}: parameters not an object`)
    assert.ok(tool.description.length > 40, `${tool.name}: description too short`)
    assert.ok(tool.output?.schema, `${tool.name}: no output schema`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name}: no render`)
    assert.equal(typeof tool.execute, 'function', `${tool.name}: no execute`)
  }
})

await check('output schemas are strict and consistent', () => {
  for (const tool of toolset) {
    const schema = tool.output.schema
    assert.equal(schema.additionalProperties, false, `${tool.name}: schema is not closed`)
    assert.ok(Array.isArray(schema.required), `${tool.name}: no required list`)
    const props = Object.keys(schema.properties)
    for (const key of schema.required) {
      assert.ok(props.includes(key), `${tool.name}: required "${key}" is not a property`)
    }
    // The harness enforces one scalar type per node; nullability uses oneOf.
    for (const [key, node] of Object.entries(schema.properties)) {
      assert.ok(!Array.isArray(node.type), `${tool.name}.${key}: type array is not allowed`)
    }
  }
})

await check('mole_status returns the documented shape', async () => {
  const value = await byName.mole_status.execute({}, {})
  const schema = byName.mole_status.output.schema
  for (const key of schema.required) {
    assert.ok(key in value, `missing key ${key}`)
  }
  assert.ok(Array.isArray(value.disks) && value.disks.length > 0)
  const text = byName.mole_status.output.render({}, value)[0].text
  assert.ok(text.includes(value.host), 'render omits the host')
})

await check('mole_clean_preview renders and caps paths', async () => {
  const value = await byName.mole_clean_preview.execute({ includePaths: true }, {})
  assert.ok(value.categories.length > 0, 'no categories')
  assert.ok(value.paths.length <= 40, 'path cap not applied')
  const text = byName.mole_clean_preview.output.render({}, value)[0].text
  assert.ok(text.includes(value.potentialSpace), 'render omits the total')
})

await check('mole_clean defaults to a preview and deletes nothing', async () => {
  const value = await byName.mole_clean.execute({}, {})
  assert.equal(value.executed, false, 'a bare call executed a cleanup')
  assert.equal(value.approval, 'not-required')
})

await check('mole_clean fails closed when no approval seam exists', async () => {
  const tools = createTools(service, { requestApproval: undefined, logger: { info() {}, warn() {} } })
  const clean = tools.find((t) => t.name === 'mole_clean')
  const value = await clean.execute({ execute: true }, {})
  assert.equal(value.executed, false, 'deleted without an approval seam')
  assert.equal(value.approval, 'unavailable')
})

await check('mole_clean fails closed when approval is rejected', async () => {
  const tools = createTools(service, { requestApproval: async () => 'rejected', logger: { info() {}, warn() {} } })
  const clean = tools.find((t) => t.name === 'mole_clean')
  const value = await clean.execute({ execute: true }, {})
  assert.equal(value.executed, false, 'deleted despite rejection')
  assert.equal(value.approval, 'rejected')
})

await check('mole_clean treats only allowed-once as a grant', async () => {
  for (const outcome of ['cancelled', 'unavailable', 'rejected']) {
    const tools = createTools(service, { requestApproval: async () => outcome, logger: { info() {}, warn() {} } })
    const clean = tools.find((t) => t.name === 'mole_clean')
    const value = await clean.execute({ execute: true }, {})
    assert.equal(value.executed, false, `deleted on outcome "${outcome}"`)
  }
})

await check('mole_clean fails closed when the approval call throws', async () => {
  const tools = createTools(service, {
    requestApproval: async () => { throw new Error('no open turn') },
    logger: { info() {}, warn() {} },
  })
  const clean = tools.find((t) => t.name === 'mole_clean')
  const value = await clean.execute({ execute: true }, {})
  assert.equal(value.executed, false, 'deleted after a throwing approval call')
  assert.equal(value.approval, 'unavailable')
})

await check('mole_inventory filters by size and caps rows', async () => {
  const value = await byName.mole_inventory.execute({ minSizeGB: 1, limit: 5 }, {})
  assert.ok(value.available, 'inventory unavailable')
  assert.ok(value.apps.length <= 5, 'row cap not applied')
  assert.ok(value.totalCount > 0, 'no total count')
})

await check('mole_info reports the launcher', async () => {
  const value = await byName.mole_info.execute({}, {})
  assert.equal(value.ok, true)
  assert.ok(value.executable.includes('mo'), 'executable looks wrong')
  assert.equal(value.outputEncoding, 'gbk')
})

// ---------------------------------------------------------------------------
// Plugin wiring
// ---------------------------------------------------------------------------

await check('apply registers tools and the panel route', () => {
  const { ctx, captured } = fakeContext()
  apply(ctx, {})
  assert.equal(captured.tools.length, 9, `expected 9 tools, got ${captured.tools.length}`)
  assert.equal(captured.routes.length, 1, 'panel route not registered')
  assert.equal(captured.routes[0].path, '/plugins/dsh-mole-tool/rpc')
  assert.equal(captured.routes[0].kind, 'exact')
})

await check('apply declares webServer through inject, never a bare read', () => {
  const { ctx, captured } = fakeContext()
  // Throws "cannot get property webServer without inject" if the plugin reads
  // the service directly. This is the regression that broke activation live.
  apply(ctx, {})
  assert.ok(
    captured.injected.some((s) => s.includes('webServer')),
    'webServer was not declared via ctx.inject',
  )
})

await check('apply keeps its tools in a profile with no web server', () => {
  const { ctx, captured } = fakeContext({ webServer: false })
  apply(ctx, {})
  assert.equal(captured.tools.length, 9, 'tools were lost without a web server')
  assert.equal(captured.routes.length, 0, 'a route registered without a web server')
})

await check('apply tolerates unknown config keys', () => {
  const { ctx, captured } = fakeContext()
  apply(ctx, { nope: true })
  assert.ok(captured.logs.some(([level, m]) => level === 'warn' && m.includes('nope')), 'no warning logged')
})

await check('panel route rejects a foreign origin', async () => {
  const { ctx, captured } = fakeContext()
  apply(ctx, {})
  const route = captured.routes[0]
  const payload = Buffer.from('{}', 'utf8')
  const req = {
    method: 'POST',
    headers: { host: '127.0.0.1:19387', origin: 'https://evil.example' },
    async *[Symbol.asyncIterator]() { yield payload },
  }
  let status = 0
  let text = ''
  await route.handler(req, { writeHead: (c) => { status = c }, end: (c) => { text = c } })
  assert.equal(status, 403, 'cross-origin request was not rejected')
  assert.equal(JSON.parse(text).error, 'origin-rejected')
})

await check('panel route rejects a non-POST method', async () => {
  const { ctx, captured } = fakeContext()
  apply(ctx, {})
  const result = await callRoute(captured.routes[0], {}, 'GET')
  assert.equal(result.status, 405)
})

await check('panel route answers info', async () => {
  const { ctx, captured } = fakeContext()
  apply(ctx, {})
  const result = await callRoute(captured.routes[0], { action: 'info' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.ok(result.body.executable.includes('mo'))
})

await check('panel route answers status', async () => {
  const { ctx, captured } = fakeContext()
  apply(ctx, {})
  const result = await callRoute(captured.routes[0], { action: 'status' })
  assert.equal(result.status, 200)
  assert.ok(typeof result.body.snapshot.health_score === 'number')
})

await check('panel route answers cleanPreview', async () => {
  const { ctx, captured } = fakeContext()
  apply(ctx, {})
  const result = await callRoute(captured.routes[0], { action: 'cleanPreview' })
  assert.equal(result.status, 200)
  assert.ok(result.body.preview.categories.length > 0)
})

await check('panel route answers inventory', async () => {
  const { ctx, captured } = fakeContext()
  apply(ctx, {})
  const result = await callRoute(captured.routes[0], { action: 'inventory' })
  assert.equal(result.status, 200)
  assert.ok(result.body.inventory.count > 0)
})

await check('panel route rejects an unknown action', async () => {
  const { ctx, captured } = fakeContext()
  apply(ctx, {})
  const result = await callRoute(captured.routes[0], { action: 'rm-rf' })
  assert.equal(result.status, 400)
  assert.equal(result.body.error, 'unknown-action')
})

await check('panel route rejects an unknown interactive screen', async () => {
  const { ctx, captured } = fakeContext()
  apply(ctx, {})
  const result = await callRoute(captured.routes[0], { action: 'open', screen: 'clean' })
  assert.equal(result.status, 400)
  assert.equal(result.body.error, 'unknown-screen')
})

await check('panel route has no action that deletes files', async () => {
  const { ctx, captured } = fakeContext()
  apply(ctx, {})
  for (const action of ['clean', 'delete', 'purge', 'execute']) {
    const result = await callRoute(captured.routes[0], { action })
    assert.equal(result.status, 400, `panel action "${action}" was accepted`)
  }
})

// ---------------------------------------------------------------------------

console.log(results.join('\n'))
console.log(`\n${results.length - failures}/${results.length} checks passed`)
process.exit(failures === 0 ? 0 : 1)
