'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm')
const { pathToFileURL } = require('node:url')

test('Host metadata uses the verified Desktop package and live attached agents, never the gateway', async t => {
  const { hostDescription } = await import('../packages/plugin/index.mjs')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-host-description-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dir = path.join(home, 'profiles', 'desktop'), runtimeDir = path.join(home, 'runtime')
  const hostRoot = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(hostRoot, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
  fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime', version: '0.2.1' }))
  fs.writeFileSync(path.join(hostRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop-host', version: '0.2.1' }))
  const entry = path.join(hostRoot, 'lib', 'index.js')
  fs.writeFileSync(entry, ''); fs.writeFileSync(path.join(hostRoot, 'lib', 'cli.js'), '')
  const ctx = { root: { baseUrl: pathToFileURL(dir + path.sep).href }, agents: { list: () => [{ id: 'a' }, { id: 'b' }] } }
  const runtime = { versions: { electron: '40' }, argv: ['electron', entry, runtimeDir, dir], cwd: () => home }
  let result = hostDescription(ctx, runtime)
  assert.equal(result.version, '0.2.1')
  assert.equal(result.cwd, home)
  assert.equal(result.attachedSessions, 2)
  assert.equal(result.metadataOnly, true)
  ctx.agents.list = () => []
  assert.equal(hostDescription(ctx, runtime).attachedSessions, 0)
  ctx.agents.list = () => { throw Error('unavailable') }
  assert.equal(hostDescription(ctx, runtime).attachedSessions, null)
  runtime.argv[3] = home
  result = hostDescription(ctx, runtime)
  assert.equal(result.version, null, 'a mismatched profile cannot supply a package version')
  assert.equal(result.cwd, home)
})

test('modern host.describe reads authenticated Host metadata afresh and preserves partial/older-server evidence', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../gateway.js'), 'utf8')
  let response, requests = []
  const modernState = { home: '/dsh-home', hostInfo: { version: null, cwd: null, attachedSessions: null } }
  const context = vm.createContext({ modernState, UPSTREAM: new URL('http://127.0.0.1:39999'), TOKEN: 'fixture-token', URL, AbortSignal,
    dshUpstreamHeaders: headers => ({ ...headers, cookie: 'fixture-cookie' }),
    fetch: async (url, options) => { requests.push({ url: String(url), options }); if (response instanceof Error) throw response; return response },
  })
  vm.runInContext(source.slice(source.indexOf('function legacyEnvelope('), source.indexOf('function modernResponseNeedsLegacyFallback('))
    + source.slice(source.indexOf('async function translateModernRpc('), source.indexOf('/** 递归截断')), context)
  response = { ok: true, json: async () => ({ ok: true, metadataOnly: true, version: '0.2.1', cwd: '/actual-host-cwd', attachedSessions: 2, home: '/host-home' }) }
  let value = (await context.translateModernRpc('host.describe', {}, 'one')).result.value
  assert.equal(value.version, '0.2.1'); assert.equal(value.cwd, '/actual-host-cwd'); assert.equal(value.attachedSessions, 2)
  assert.equal(value.canOpenPath, false)
  assert.equal(requests[0].url, 'http://127.0.0.1:39999/remote/api/host-description')
  assert.equal(requests[0].options.headers.authorization, 'Bearer fixture-token')
  assert.equal(requests[0].options.headers.cookie, 'fixture-cookie')
  assert.equal(requests[0].options.redirect, 'error')
  response = { ok: true, json: async () => ({ ok: true, metadataOnly: true, attachedSessions: 0 }) }
  value = (await context.translateModernRpc('host.describe', {}, 'two')).result.value
  assert.equal(value.attachedSessions, 0); assert.equal(value.version, null, 'last request is not cached')
  modernState.hostInfo = { version: 'ws-version', cwd: '/ws-cwd', attachedSessions: 3 }
  for (const failure of [{ ok: false }, Error('offline'), { ok: true, json: async () => { throw Error('bad JSON') } }]) {
    response = failure
    value = (await context.translateModernRpc('host.describe', {}, 'fallback')).result.value
    assert.equal(value.version, 'ws-version'); assert.equal(value.cwd, '/ws-cwd'); assert.equal(value.attachedSessions, 3)
  }
  modernState.hostInfo = { version: null, cwd: null, attachedSessions: null }; modernState.home = ''
  value = (await context.translateModernRpc('host.describe', {}, 'unavailable')).result.value
  assert.equal(value.cwd, null); assert.equal(value.home, null, 'gateway home must not masquerade as Host home')
})
