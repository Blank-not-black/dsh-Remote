'use strict'
// Opt-in host service integration; temporary profile only, no model invocation.
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process'), { once } = require('node:events')
const { createRealisticStack } = require('./fixtures/realistic-stack.cjs')
test('installed DSH registers and executes all three file tools with its real filesystem and working-directory services', { skip: !process.env.DSH_TEST_CLI_ROOT, timeout: 45000 }, async t => {
  const s = await createRealisticStack(), home = path.join(s.tmpRoot, 'dsh-fixture'), output = path.join(home, 'result.json')
  fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'report.txt'), 'DSH real tool delivery')
  let child
  t.after(async () => { if (child?.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done } await s.stop() })
  const receiverKey = 'a'.repeat(64), headers = { authorization: 'Bearer ' + s.token, 'content-type': 'application/json', 'x-dsh-remote-inbox-key': receiverKey }
  const receiver = await (await fetch(s.base + '/api/file-inbox', { method: 'POST', headers, body: JSON.stringify({ action: 'register', name: 'isolated receiver' }) })).json()
  const fixture = path.join(home, 'probe.mjs'), patch = path.join(home, 'patch.json')
  fs.writeFileSync(fixture, `import {writeFileSync} from 'node:fs';export const inject=['tools','fs','workingDirectory','sessions'];export function apply(ctx){
    const run=async()=>{for(let i=0;i<100;i++){if(ctx.tools.get('remote_send_file'))break;await new Promise(r=>setTimeout(r,50))}
      const names=['remote_devices','remote_send_file','remote_file_status'],defs=names.map(name=>ctx.tools.get(name));if(defs.some(d=>!d))throw Error('Tool registration unavailable');
      const session=ctx.sessions.create('remote-file-fixture',{meta:{cwd:${JSON.stringify(home)}}}),exec={agent:{session,ctx},callId:'real-host-call',signal:new AbortController().signal};
      const devices=await defs[0].execute({},exec),sent=await defs[1].execute({path:'report.txt',device_id:${JSON.stringify(receiver.id)}},exec),receipt=JSON.parse(sent.details),status=await defs[2].execute({transfer_id:receipt.id},exec);
      writeFileSync(${JSON.stringify(output)},JSON.stringify({names,devices,sent,status}));};run().catch(error=>writeFileSync(${JSON.stringify(output)},JSON.stringify({error:String(error),stack:error.stack})));}`)
  fs.writeFileSync(patch, JSON.stringify([{ insert: [{ id: 'remote-file-plugin', name: path.join(__dirname, '../packages/plugin/index.mjs').replaceAll('\\', '/') }, { id: 'remote-file-probe', name: fixture.replaceAll('\\', '/') }] }]))
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh'), DSH_REMOTE_FS_ROOT: s.tmpRoot, TOKEN: s.token, DSH_REMOTE_TOKEN: s.token, DSH_REMOTE_AUTOSTART: '0', DSH_REMOTE_GATEWAY: s.base }
  for (const k of Object.keys(env)) if (/proxy|api[_-]?key|secret/i.test(k)) delete env[k]
  child = spawn(process.execPath, [path.join(process.env.DSH_TEST_CLI_ROOT, 'lib/bin.js'), '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { logs = (logs + b).slice(-12000) })
  const end = Date.now() + 35000
  while (!fs.existsSync(output) && child.exitCode === null && Date.now() < end) await new Promise(r => setTimeout(r,100))
  assert.ok(fs.existsSync(output), logs.replace(/(token[=:])[^\s&]+/gi, '$1[redacted]'))
  const result = JSON.parse(fs.readFileSync(output)); assert.ok(!result.error, JSON.stringify(result))
  assert.equal(JSON.parse(result.sent.details).phase, 'pending'); assert.equal(JSON.parse(result.status.details).phase, 'pending')
  const transfer = JSON.parse(result.sent.details)
  const consent = await (await fetch(s.base + '/api/file-inbox', { method: 'POST', headers, body: JSON.stringify({ action: 'accept', id: transfer.id }) })).json()
  const bytes = await (await fetch(s.base + '/fs/inbox-file?id=' + transfer.id + '&ticket=' + consent.ticket, { headers })).text()
  assert.equal(bytes, 'DSH real tool delivery')
  t.diagnostic('Real DSH ' + JSON.parse(fs.readFileSync(path.join(process.env.DSH_TEST_CLI_ROOT, 'package.json'))).version + ': registered tools, working directory, filesystem, queue, consent and exact bytes passed without a model call.')
})
