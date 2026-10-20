'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { spawn } = require('node:child_process'), { once } = require('node:events')
const http = require('node:http'), { pathToFileURL } = require('node:url')

for (const withIndex of [false, true]) test('installed DSH: official market ' + (withIndex ? 'search and stable pages' : 'service discovery') + ' and durable user images', { skip: !process.env.DSH_TEST_CLI_ROOT, timeout: 45000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-market-probe-')), output = path.join(home, 'probe.json')
  const index = { format: 1, title: 'Fixture catalog', metadata: { categories: { cost: { title: '费用' } }, labels: {}, sortKeys: {} }, plugins: [0, 1].map(i => ({ name: 'cost-fixture-' + i, title: '费用', metadata: { category: 'cost', keywords: [], labels: [], sortKeys: {} }, versions: [{ version: '1.0.0', publishTimestamp: 1000000, source: { type: 'npm' }, engines: {} }] })) }
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(index)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const indexes = withIndex ? ['http://127.0.0.1:' + server.address().port + '/index.json'] : []
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh'), DSH_REMOTE_FS_ROOT: home, TOKEN: 'market-probe-only', DSH_REMOTE_TOKEN: 'market-probe-only', DSH_REMOTE_AUTOSTART: '0' }
  for (const key of Object.keys(env)) if (/proxy|api[_-]?key|secret/i.test(key)) delete env[key]
  const fixture = path.join(home, 'probe.mjs'), patch = path.join(home, 'patch.json')
  fs.writeFileSync(fixture, `import {writeFileSync,readFileSync} from 'node:fs';import {createMarketAdapter} from ${JSON.stringify(pathToFileURL(path.join(__dirname, '../packages/plugin/market.mjs')).href)};export const inject=['webServer','pluginMarket','sessions','attachments'];export function apply(ctx){const service=ctx.get('pluginMarket');Promise.resolve(service.listIndexes()).then(async indexes=>{
    const adapter=createMarketAdapter(ctx),query={text:'费用',sort:{kind:'relevance'},offset:0,limit:1};const first=${withIndex}?await adapter.search('',query):null;const second=first?.available?await adapter.search('',{...query,offset:1,fetchedAt:first.fetchedAt}):null;
    const image=await ctx.get('attachments').saveImage({data:readFileSync(${JSON.stringify(path.join(__dirname, '../docs/screenshots/plugin-panel-latest.png'))}),mediaType:'image/png',name:'fixture.png'});
    const session=ctx.sessions.create('preview-image-fixture',{meta:{cwd:${JSON.stringify(home)}}});session.append('user/message',{id:'fixture-user',role:'user',source:{kind:'user'},content:[{type:'image',attachment:image}]},{surfaceOp:'append'});
    ctx.sessions.create('preview-image-other',{meta:{cwd:${JSON.stringify(home)}}});
    writeFileSync(${JSON.stringify(output)},JSON.stringify({type:typeof service,methods:['listIndexes','search','setIndexes'].filter(name=>typeof service[name]==='function'),indexes,services:Object.keys(ctx.reflect.props).sort(),image,first,second}));
  }).catch(error=>writeFileSync(${JSON.stringify(output)},JSON.stringify({error:String(error)})))}`)
  fs.writeFileSync(patch, JSON.stringify([{ insert: [
    { id: 'remote-market-official', name: path.join(process.env.DSH_TEST_CLI_ROOT, 'node_modules/@deepseek-ai/dsh-plugin-market/lib/index.js').replaceAll('\\', '/'), config: { indexes } },
    { id: 'remote-market-client', name: path.join(__dirname, '../packages/plugin/index.mjs').replaceAll('\\', '/') },
    { id: 'remote-market-probe', name: fixture.replaceAll('\\', '/') },
  ] }]))
  const child = spawn(process.execPath, [path.join(process.env.DSH_TEST_CLI_ROOT, 'lib/bin.js'), '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(async () => { if (child.exitCode === null) { const closed = once(child, 'exit'); child.kill(); await closed } fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-12000) })
  const deadline = Date.now() + 30000
  while (!fs.existsSync(output) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(fs.existsSync(output), 'No service probe result: ' + logs.replace(/(token[=:])[^\s&]+/gi, '$1[redacted]'))
  const result = JSON.parse(fs.readFileSync(output))
  t.diagnostic(JSON.stringify(result))
  assert.equal(result.type, 'object'); assert.ok(result.methods.includes('listIndexes')); assert.ok(result.methods.includes('search')); assert.equal(result.indexes.length, indexes.length)
  if (withIndex) {
    assert.equal(result.first?.available, true, JSON.stringify(result.first)); assert.equal(result.first.items[0].name, 'cost-fixture-0'); assert.equal(result.first.nextOffset, 1)
    assert.equal(result.second.items[0].name, 'cost-fixture-1'); assert.equal(result.second.fetchedAt, result.first.fetchedAt); assert.equal(result.second.items[0].installSupported, true)
  }
  let url
  while (!(url = logs.match(/http:\/\/127\.0\.0\.1:\d+[^\s\x1b]*/)?.[0]) && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(url)
  const login = await fetch(url, { redirect: 'manual' }), cookie = login.headers.get('set-cookie')?.split(';')[0]
  const read = async sessionId => {
    const response = await fetch(new URL('/api/session/attachment', url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'image-probe', method: 'session/attachment', payload: { args: { request: { sessionId, attachmentId: result.image.attachmentId } } } }) })
    return response.json()
  }
  const attachment = await read('preview-image-fixture')
  assert.equal(attachment.result?.ok, true, JSON.stringify(attachment)); assert.equal(attachment.result.value.attachment.attachmentId, result.image.attachmentId)
  assert.equal(Buffer.from(attachment.result.value.data, 'base64').length, result.image.bytes)
  assert.equal((await read('preview-image-other')).result?.ok, false)
  t.diagnostic('Real durable user image read succeeded; the same image was refused in another session. No model was invoked.')
})
