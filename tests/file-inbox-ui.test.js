'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto')
function fixture({ native = null, gate, pollGate, corrupt = false } = {}) {
  const calls = [], storage = new Map(), bytes = Buffer.from('report'), row = { id: 'isolated-transfer-123456', fileName: '报告.txt', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), phase: 'pending' }
  let generation = 0, ack = 0
  const c = vm.createContext({ crypto: crypto.webcrypto, Uint8Array, TextEncoder, AbortSignal, AbortController, Blob, URL, Date, location: { href: 'http://localhost/' },
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    fetch: async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : null; calls.push({ url, body, options })
      if (body?.action === 'accept') { await gate?.(); row.phase = 'accepted'; return { ok: true, json: async () => ({ ...row, ticket: 'temporary-ticket' }) } }
      if (body?.action === 'receipt') { row.phase = body.phase; ack++; return { ok: true, json: async () => ({ ...row }) } }
      if (body?.action === 'reject') { row.phase = 'rejected'; return { ok: true, json: async () => ({ ...row }) } }
      if (body?.action === 'register') return { ok: true, json: async () => ({ id: 'device', name: body.name }) }
      if (url.includes('/fs/inbox-file?')) { row.phase = 'downloading'; return { ok: true, arrayBuffer: async () => { const b = Buffer.from(corrupt ? 'wrong!' : bytes); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } } }
      const snapshot = { transfers: [{ ...row }] }; await pollGate?.()
      return { ok: true, json: async () => snapshot }
    } })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/file-inbox.js'), 'utf8'), c)
  const config = { capture: () => { const version = generation; return { token: 'isolated-token', valid: () => generation === version } }, url: sub => 'http://localhost' + sub, headers: connection => ({ authorization: 'Bearer ' + connection.token }), native: () => native }
  return { client: c.DshFileInbox.createClient(config), recreate: () => c.DshFileInbox.createClient(config), api: c.DshFileInbox, context: c, config, row, calls, storage, change: () => generation++, ack: () => ack }
}
test('inbox does not accept or download during polling; browser save acknowledgement requires explicit handoff', async () => {
  const f = fixture(); await f.client.sync()
  assert.equal(f.calls.filter(c => c.body?.action === 'accept' || c.url.includes('/fs/inbox-file?')).length, 0)
  const prepared = await f.client.receive(f.row)
  assert.equal(prepared.native, false); assert.equal(prepared.blob.size, 6)
  assert.equal(f.ack(), 0, 'receiving bytes is not the same as saving them')
  await prepared.handedOff(); assert.equal(f.ack(), 1); assert.equal(f.row.phase, 'downloaded')
  assert.doesNotMatch([...f.storage.values()].join(''), /isolated-token|temporary-ticket|报告/)
})
test('rejecting a file never creates a download, corrupt bytes never become a saveable file', async () => {
  const f = fixture(); await f.client.sync(); await f.client.reject(f.row)
  assert.equal(f.row.phase, 'rejected'); assert.ok(!f.calls.some(c => c.url.includes('/fs/inbox-file?')))
  const bad = fixture({ corrupt: true }); await bad.client.sync()
  await assert.rejects(bad.client.receive(bad.row), /校验失败/)
  assert.equal(bad.row.phase, 'failed')
})
test('host change while acceptance is pending never downloads from or writes a receipt to the new host', async () => {
  let release; const f = fixture({ gate: () => new Promise(resolve => { release = resolve }) }); await f.client.sync()
  const receiving = f.client.receive(f.row)
  await waitFor(() => release)
  assert.ok(release); f.change(); f.client.reset(); release()
  await assert.rejects(receiving, /连接已改变/)
  assert.ok(!f.calls.some(c => c.url.includes('/fs/inbox-file?') || c.body?.action === 'receipt'))
})
test('native downloads keep their id across reload and acknowledge only the system completion result', async () => {
  let complete = false, started = 0
  const native = { downloadToDownloads: () => { started++; return '123' }, getFileDownloadStatus: () => JSON.stringify({ phase: complete ? 'complete' : 'downloading' }) }
  const f = fixture({ native }); await f.client.sync(); await f.client.receive(f.row)
  assert.equal(started, 1); assert.equal(f.ack(), 0)
  complete = true
  await f.recreate().sync()
  assert.equal(started, 1); assert.equal(f.row.phase, 'complete'); assert.equal(f.ack(), 1)
})

test('a removed native download becomes retryable after reload without starting another download automatically', async () => {
  let phase = 'downloading', started = 0
  const native = { downloadToDownloads: () => String(++started), getFileDownloadStatus: () => JSON.stringify({ phase }) }
  const f = fixture({ native }); await f.client.sync(); await f.client.receive(f.row)
  f.row.phase = 'downloading'
  for (phase of ['downloading', 'paused']) {
    const value = await f.recreate().sync()
    assert.equal(value.jobs[f.row.id], '1'); assert.equal(f.ack(), 0)
  }
  phase = 'unknown'
  const client = f.recreate(), value = await client.sync()
  assert.equal(value.jobs[f.row.id], undefined); assert.equal(f.row.phase, 'failed')
  assert.equal(f.ack(), 1); assert.equal(started, 1)
  assert.equal((await f.recreate().sync()).jobs[f.row.id], undefined, 'discarded job stays cleared after another reload')
  await client.receive(f.row)
  assert.equal(started, 2, 'only a new explicit acceptance starts another download')
})

test('an unreadable native status retains the job instead of falsely reporting a failed download', async () => {
  const f = fixture({ native: { downloadToDownloads: () => '123', getFileDownloadStatus: () => { throw Error('bridge unavailable') } } })
  await f.client.sync(); await f.client.receive(f.row)
  assert.equal((await f.recreate().sync()).jobs[f.row.id], '123'); assert.equal(f.ack(), 0)
})

class InboxElement {
  constructor(tag, doc) { this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.children=[];this.dataset={};this.listeners={};this.className='';this.textContent='' }
  append(...els) { for(const el of els)el.parentElement=this;this.children.push(...els) }
  replaceChildren(...els) { if(this.children.some(el=>el.contains(this.ownerDocument.activeElement)))this.ownerDocument.activeElement=this.ownerDocument.body;for(const el of this.children)el.parentElement=null;this.children=[];this.append(...els) }
  all() { return this.children.flatMap(el=>[el,...el.all()]) }
  contains(el) { return el===this||this.all().includes(el) }
  addEventListener(event, fn) { this.listeners[event]=fn }
  removeEventListener(event) { delete this.listeners[event] }
  setAttribute() {}
  closest() { for(let el=this;el;el=el.parentElement)if(el.hidden||el.inert||el.className.split(' ').includes('hidden'))return el;return null }
  getClientRects() { return this.closest()?[]:[{}] }
  focus() { if(!this.disabled&&this.getClientRects().length)this.ownerDocument.activeElement=this }
  click() { return this.listeners.click?.() }
  remove() {}
  querySelectorAll(selector) { return this.all().filter(el=>selector==='[data-inbox-focus]'?!!el.dataset.inboxFocus:selector==='button,input'?['BUTTON','INPUT'].includes(el.tagName):el.tagName===selector.toUpperCase()) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] }
}
function mountedFixture(options) {
  const f=fixture(options),doc={visibilityState:'visible',activeElement:null,addEventListener(){},removeEventListener(){},querySelectorAll(){return[]}}
  doc.createElement=tag=>new InboxElement(tag,doc);doc.body=doc.createElement('body')
  const files=doc.createElement('section'),session=doc.createElement('section')
  doc.getElementById=id=>id==='file-inbox-files'?files:id==='file-inbox-session'?session:null
  f.context.document=doc;f.context.setInterval=()=>1;f.context.clearInterval=()=>{}
  f.context.requestAnimationFrame=fn=>setImmediate(fn)
  Object.assign(f.row,{sessionId:'s1',expiresAt:Date.now()+60000})
  Object.assign(f.row,options?.row)
  const view={sessionId:'s1',inChat:true};let navigated=false
  f.config.context=()=>view;f.config.openFiles=()=>{navigated=true;view.inChat=false}
  const ui=f.api.mount(f.config)
  return {...f,files,session,view,ui,doc,navigated:()=>navigated,ready:()=>waitFor(()=>findButton(session,'接收文件'))}
}
async function waitFor(predicate) {
  const deadline=Date.now()+5000
  while(!predicate()){assert.ok(Date.now()<deadline,'timed out waiting for the inbox state');await new Promise(resolve=>setTimeout(resolve,5))}
}
const settled=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve))}
const findButton=(slot,text)=>slot.all().find(el=>el.tagName==='BUTTON'&&el.textContent===text)
const cards=slot=>slot.all().filter(el=>el.tagName==='ARTICLE')

test('inline requests follow the current conversation, file page keeps all and rejection moves into history',async()=>{
  const f=mountedFixture();await f.ready()
  assert.equal(f.session.hidden,false);assert.equal(cards(f.session).length,1);assert.equal(cards(f.files).length,1)
  assert.ok(findButton(f.session,'接收文件'));assert.ok(findButton(f.session,'拒绝'))
  f.view.sessionId='s2';f.ui.render();assert.equal(f.session.hidden,true);assert.equal(cards(f.files).length,1)
  f.view.sessionId='s1';f.view.inChat=false;f.ui.render();assert.equal(f.session.hidden,true)
  await findButton(f.files,'拒绝').click()
  assert.equal(f.row.phase,'rejected');assert.equal(cards(f.files).length,1)
  assert.ok(f.files.all().some(el=>el.className==='file-inbox-history'))
  f.view.inChat=true;f.ui.render();assert.equal(f.session.hidden,true)
  assert.ok(!f.calls.some(c=>c.url.includes('/fs/inbox-file?')))
  f.ui.destroy()
})

test('prepared file survives navigation; identity reset removes both copies and device text survives redraw',async()=>{
  const f=mountedFixture();await f.ready()
  const input=f.files.all().find(el=>el.tagName==='INPUT');input.value='我的接收设备';input.focus();f.ui.render()
  assert.equal(f.doc.activeElement.value,'我的接收设备')
  await findButton(f.session,'接收文件').click()
  assert.ok(findButton(f.session,'保存文件'));assert.equal(f.ack(),0)
  await f.ui.open();assert.equal(f.navigated(),true);assert.equal(f.session.hidden,true)
  assert.ok(findButton(f.files,'保存文件'));assert.equal(f.ack(),0)
  f.ui.reset();assert.equal(cards(f.files).length,0);assert.equal(f.session.hidden,true)
  assert.equal(findButton(f.files,'保存文件'),undefined)
  f.ui.destroy()
})

test('a poll started before acceptance cannot discard the verified file when its old reply arrives late',async()=>{
  let hold=0,release
  const f=mountedFixture({pollGate:()=>{if(hold&&!--hold)return new Promise(resolve=>{release=resolve})}});await f.ready()
  hold=2;const polling=f.ui.refresh();await waitFor(()=>release)
  await findButton(f.session,'接收文件').click();assert.ok(findButton(f.session,'保存文件'))
  release();await polling
  assert.ok(findButton(f.session,'保存文件'),'late pending snapshot must not erase prepared bytes')
  assert.equal(f.ack(),0);f.ui.destroy()
})

for(const placement of ['session','files'])test(placement+': accepting by keyboard restores focus to Save after the original focused node is removed',async()=>{
  const f=mountedFixture();await f.ready()
  if(placement==='files'){f.view.inChat=false;f.ui.render()}
  const slot=f[placement],accept=findButton(slot,'接收文件');accept.focus()
  await accept.click();await settled()
  assert.equal(f.doc.activeElement,findButton(slot,'保存文件'))
  assert.equal(f.ack(),0);f.ui.destroy()
})

test('finishing a receive never steals focus from another control or a different conversation',async()=>{
  for(const change of ['focus','session','reset','destroy']){
    let release;const f=mountedFixture({gate:()=>new Promise(resolve=>{release=resolve})});await f.ready()
    const accept=findButton(f.session,'接收文件');accept.focus();const receiving=accept.click();await waitFor(()=>release)
    const elsewhere=f.doc.createElement('textarea')
    if(change==='focus')elsewhere.focus()
    if(change==='session')f.view.sessionId='s2'
    if(change==='reset')f.ui.reset()
    if(change==='destroy')f.ui.destroy()
    release();await receiving;await settled()
    assert.equal(f.doc.activeElement,change==='focus'?elsewhere:f.doc.body,change)
    if(change!=='destroy')f.ui.destroy()
  }
})

test('compact file cards put identity, size and purpose before actions and retain full details',async()=>{
  const purpose='供你核对发票金额与付款日期',title='十月报销单'
  const f=mountedFixture({row:{title,message:purpose,fileName:'报销单.pdf'}});await f.ready()
  const card=cards(f.session)[0],els=card.all(),details=els.find(el=>el.tagName==='DETAILS')
  assert.equal(els.find(el=>el.className==='file-inbox-filename').textContent,'报销单.pdf')
  assert.equal(els.find(el=>el.className==='file-inbox-size').textContent,'PDF · 6 B')
  assert.equal(els.find(el=>el.className==='file-inbox-message').textContent,title+' · '+purpose)
  assert.ok(details.all().some(el=>el.textContent.includes(purpose)));assert.ok(details.all().some(el=>el.textContent.includes('来源会话')))
  assert.ok(!els.some(el=>el.className==='file-inbox-eyebrow'||el.textContent==='等待接收'))
  assert.ok(findButton(f.session,'接收文件'));assert.ok(findButton(f.session,'拒绝'));assert.equal(f.ack(),0)
  await findButton(f.session,'接收文件').click();assert.ok(f.session.all().some(el=>el.textContent==='传输校验通过'));assert.ok(findButton(f.session,'保存文件'));assert.equal(f.ack(),0)
  f.ui.destroy()
})
