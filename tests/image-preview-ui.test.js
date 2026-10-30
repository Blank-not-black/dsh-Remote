'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path')
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8')

class El {
  constructor(name, attrs = {}) {
    this.name = name; this.attrs = { ...attrs }; this.className = ''; this.style = {}
    this.textContent = ''; this.src = ''; this.alt = ''; this.naturalWidth = 0; this.naturalHeight = 0
    this.scrollWidth = 0; this.scrollHeight = 0; this.clientWidth = 0; this.clientHeight = 0
    this.listeners = {}; this.focused = false; this.children = []; this.nodeType = 1
  }
  get classList() {
    const owner = this
    const set = new Set(owner.className.split(' ').filter(Boolean))
    return {
      add(...names) { for (const name of names) set.add(name); owner.className = [...set].join(' ') },
      remove(...names) { for (const name of names) set.delete(name); owner.className = [...set].join(' ') },
      toggle(name, force) { const on = force === undefined ? !set.has(name) : !!force; on ? this.add(name) : this.remove(name); return on },
      contains(name) { return set.has(name) },
    }
  }
  setAttribute(name, value) { this.attrs[name] = String(value) }
  getAttribute(name) { return this.attrs[name] }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
  fire(type, event = {}) { for (const fn of this.listeners[type] || []) fn({ target: this, preventDefault() {}, ...event }) }
  querySelector(selector) {
    const map = { '[data-image-lightbox-stage]': 'stage', '[data-image-lightbox-img]': 'image', '[data-image-lightbox-close]': 'close', '[data-image-lightbox-hint]': 'hint' }
    return this.children.find(child => child.name === map[selector]) || null
  }
  querySelectorAll() { return [] }
  matches(selector) { return selector === '[data-chat-image][data-chat-image-path]' && this.dataset?.chatImagePath !== undefined }
  closest(selector) { return this.matches === selector ? this : null }
  replaceChildren(...nodes) { this.children = nodes }
  removeAttribute(name) { delete this.attrs[name] }
  focus() { this.focused = true }
}

function pathButton(path = 'dist/example.png') {
  const status = new El('status'); status.textContent = '图片'
  const button = new El('button')
  button.dataset = { chatImagePath: path, chatImageAlt: '示例图' }
  button.className = 'chat-image is-loading'
  button.children = [status]
  button.querySelector = selector => selector === '.chat-image-status' ? status : null
  return { button, status }
}

function fixture(lang = 'zh', fetchImpl) {
  const lightbox = new El('lightbox', { id: 'image-lightbox' })
  lightbox.className = 'image-lightbox hidden'
  const stage = new El('stage'); const image = new El('image'); const close = new El('close'); const hint = new El('hint')
  image.naturalWidth = 320; image.naturalHeight = 200
  stage.scrollWidth = 900; stage.scrollHeight = 700; stage.clientWidth = 400; stage.clientHeight = 500
  lightbox.children.push(stage, image, close, hint)
  const body = new El('body')
  const createElement = tag => new El(tag)
  const document = {
    body, activeElement: null, createElement,
    querySelectorAll: () => [],
    getElementById: id => id === 'image-lightbox' ? lightbox : null,
    addEventListener(type, fn) { (document.listeners[type] ||= []).push(fn) },
    fire(type, event = {}) { for (const fn of document.listeners[type] || []) fn({ preventDefault() {}, ...event }) },
    listeners: {},
  }
  const URL = { createObjectURL: () => 'blob:image' }
  const c = vm.createContext({ window: { document, I18N: { lang }, requestAnimationFrame: fn => fn(), fetch: fetchImpl, URL }, document, I18N: { lang }, requestAnimationFrame: fn => fn(), fetch: fetchImpl, URL, console, JSON })
  c.window.document = document
  vm.runInContext(read('public/image-preview.js'), c)
  const api = c.window.DshImagePreview
  api.mount()
  return { api, lightbox, stage, image, close, hint, body, document, window: c.window }
}

test('opening a chat image fills the lightbox, locks the page and labels it', () => {
  const h = fixture()
  h.api.open('data:image/png;base64,AAAA', '架构图')
  assert.equal(h.lightbox.classList.contains('hidden'), false)
  assert.equal(h.image.src, 'data:image/png;base64,AAAA')
  assert.equal(h.image.alt, '架构图')
  assert.equal(h.body.classList.contains('image-preview-open'), true)
  assert.equal(h.lightbox.getAttribute('aria-label'), '图片预览')
  assert.equal(h.close.getAttribute('aria-label'), '关闭')
  assert.match(h.hint.textContent, /双击放大/)
})

test('backdrop, close button and Escape all close and unlock the page', () => {
  const h = fixture()
  h.api.open('data:image/png;base64,AAAA')
  h.lightbox.fire('click')
  assert.equal(h.lightbox.classList.contains('hidden'), true)
  assert.equal(h.body.classList.contains('image-preview-open'), false)
  h.api.open('data:image/png;base64,BBBB')
  h.close.fire('click')
  assert.equal(h.lightbox.classList.contains('hidden'), true)
  assert.equal(h.body.classList.contains('image-preview-open'), false)
  h.api.open('data:image/png;base64,CCCC')
  h.document.fire('keydown', { key: 'Escape' })
  assert.equal(h.lightbox.classList.contains('hidden'), true)
  assert.equal(h.api.isOpen(), false)
  h.document.fire('keydown', { key: 'Escape' })
  assert.equal(h.api.isOpen(), false)
})

test('a click on a rendered chat image opens the preview through delegation', () => {
  const h = fixture()
  const inner = new El('img'); inner.src = 'data:image/png;base64,DDDD'; inner.alt = '截图'
  const trigger = new El('trigger'); trigger.matches = '[data-chat-image]'; trigger.children = [inner]
  trigger.querySelector = selector => selector === 'img' ? inner : null
  h.document.fire('click', { target: trigger })
  assert.equal(h.image.src, 'data:image/png;base64,DDDD')
  assert.equal(h.image.alt, '截图')
  assert.equal(h.lightbox.classList.contains('hidden'), false)
})

test('double-tap toggles between fit and 2x zoom, empty sources are ignored', () => {
  const h = fixture()
  h.api.open('')
  assert.equal(h.api.isOpen(), false)
  h.api.open('data:image/png;base64,EEEE')
  h.image.fire('dblclick')
  assert.equal(h.lightbox.classList.contains('is-zoomed'), true)
  assert.equal(h.image.style.width, '640px')
  assert.equal(h.image.style.height, '400px')
  h.image.fire('dblclick')
  assert.equal(h.lightbox.classList.contains('is-zoomed'), false)
  assert.equal(h.image.style.width, '')
})

test('local markdown images load through an authenticated request and become previewable', async () => {
  const requests = []
  const h = fixture('zh', async (url, options) => {
    requests.push({ url, options })
    return { ok: true, blob: async () => ({ size: 12, type: 'image/png' }) }
  })
  const { button } = pathButton('dist/example.png')
  h.api.configure({ resolvePath: path => ({ url: 'http://host/fs/file?path=' + encodeURIComponent(path), headers: { authorization: 'Bearer t' } }) })
  h.api.hydrate({ querySelectorAll: () => [button] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests.length, 1)
  assert.match(requests[0].url, /fs\/file\?path=dist%2Fexample\.png/)
  assert.equal(requests[0].options.headers.authorization, 'Bearer t')
  assert.equal(button.children[0].src, 'blob:image')
  assert.equal(button.children[0].alt, '示例图')
  button.children[0].fire('load')
  assert.equal(button.classList.contains('is-loading'), false)
  assert.equal(button.classList.contains('is-loaded'), true)
  assert.equal(button.dataset.chatImageLoaded, '1')
  assert.equal(button.dataset.chatImagePath, undefined)
})

test('a failed local image request shows a readable error instead of a download link', async () => {
  const h = fixture('zh', async () => ({ ok: false, status: 404 }))
  const { button, status } = pathButton()
  h.api.configure({ resolvePath: () => 'http://host/fs/file?path=x' })
  h.api.hydrate({ querySelectorAll: () => [button] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(button.classList.contains('is-error'), true)
  assert.equal(button.classList.contains('is-loading'), false)
  assert.equal(status.textContent, '图片无法加载')
})

test('hydration is a no-op until the host supplies a path resolver', () => {
  const h = fixture()
  const { button } = pathButton()
  h.api.hydrate({ querySelectorAll: () => [button] })
  assert.equal(button.dataset.chatImageLoading, undefined)
})

test('history nodes added later are hydrated without another render call', async () => {
  const h = fixture('zh', async () => ({ ok: true, blob: async () => ({ size: 4, type: 'image/png' }) }))
  let callback = null
  h.window.MutationObserver = class { constructor(fn) { callback = fn } observe() {} }
  h.api.configure({ resolvePath: () => 'http://host/fs/file?path=x' })
  const { button } = pathButton()
  callback([{ addedNodes: [button] }])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(button.children[0]?.src, 'blob:image')
})

test('durable user image references resolve through the session attachment API and retain the lightbox', async () => {
  const h = fixture(), id = 'sha256:' + 'a'.repeat(64), calls = [], { button } = pathButton()
  delete button.dataset.chatImagePath
  Object.assign(button.dataset, { chatImageAttachment: id, chatImageSession: 'S' })
  h.api.configure({ resolveAttachment: async (...args) => { calls.push(args); return { attachment: { attachmentId: id, mediaType: 'image/png' }, data: 'AAAA' } } })
  h.api.hydrate({ querySelectorAll: selector => selector.includes('attachment') ? [button] : [] })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [[id, 'S']]); assert.equal(button.children[0].src, 'data:image/png;base64,AAAA')
  const html = h.api.attachmentHtml({ attachmentId: id, name: '<image>.png' }, '图片', 'S')
  assert.match(html, /data-chat-image-session="S"/); assert.match(html, /&lt;image&gt;/); assert.doesNotMatch(html, /data:.*base64,/)
})

test('attachment images reject mismatched identities and unsupported content types', async () => {
  for (const ref of [{ attachmentId: 'b'.repeat(64), mediaType: 'image/png' }, { attachmentId: 'a'.repeat(64), mediaType: 'image/svg+xml' }]) {
    const h = fixture(), { button, status } = pathButton(); delete button.dataset.chatImagePath
    Object.assign(button.dataset, { chatImageAttachment: 'a'.repeat(64), chatImageSession: 'S' })
    h.api.configure({ resolveAttachment: async () => ({ attachment: ref, data: 'AAAA' }) })
    h.api.hydrate({ querySelectorAll: selector => selector.includes('attachment') ? [button] : [] })
    await new Promise(resolve => setImmediate(resolve)); assert.equal(status.textContent, '图片无法加载'); assert.equal(button.classList.contains('is-error'), true)
  }
})

test('both shells reject late attachment replies after switching session or host', async () => {
  for (const file of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = read(file), start = source.indexOf('async function chatImageAttachment('), end = source.indexOf('function chatImageRequest(', start)
    let valid = true, resolve
    const state = { current: 'S' }, calls = []
    const context = vm.createContext({ state, captureConnection: () => ({ valid: () => valid }), rpc: (...args) => { calls.push(args); return new Promise(done => { resolve = done }) } })
    vm.runInContext(source.slice(start, end), context)
    const pending = context.chatImageAttachment('a'.repeat(64), 'S')
    valid = false; state.current = 'OTHER'; resolve({ data: 'AAAA' })
    await assert.rejects(pending, /stale image/); assert.equal(calls[0][0], 'session.attachment'); assert.equal(calls[0][1].sessionId, 'S')
    await assert.rejects(context.chatImageAttachment('a'.repeat(64), 'S'), /stale image/); assert.equal(calls.length, 1)
  }
})

test('both shells render chat images as preview buttons and share the lightbox markup', () => {
  for (const file of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = read(file)
    assert.match(source, /class="chat-image" data-chat-image aria-label=/, file)
    assert.match(source, /data:.*mediaType.*base64/, file)
    assert.match(source, /function chatImageRequest\(pathValue\)/, file)
    assert.match(source, /window\.DshImagePreview\?\.configure\?\.\(\{ resolvePath: chatImageRequest, resolveAttachment: chatImageAttachment, capture: captureChatImage \}\)/, file)
    assert.match(source, /window\.DshImagePreview\?\.hydrate\?\.\(\$\('history'\)\)/, file)
    assert.match(source, /imageLabel: t\('block\.image'\)/, file)
  }
  assert.doesNotMatch(read('public/desktop/desktop.js'), /b\.type === 'image'\) return `<div>/, 'desktop no longer drops images')
  const markdown = read('public/md.js')
  assert.match(markdown, /data-chat-image-path/)
  assert.match(markdown, /imageLabel/)
  for (const file of ['public/index.html', 'public/desktop/desktop.html']) {
    const html = read(file)
    assert.match(html, /id="image-lightbox"/, file)
    assert.match(html, /data-image-lightbox-stage/, file)
    assert.match(html, /data-image-lightbox-img/, file)
    assert.match(html, /image-preview\.js/, file)
  }
  const css = read('public/workflow.css')
  assert.match(css, /\.chat-image \{/)
  assert.match(css, /\.chat-image\.is-loading/)
  assert.match(css, /\.image-lightbox\.hidden \{ display:none; \}/)
  assert.match(css, /\.image-lightbox\.is-zoomed/)
  assert.match(read('public/app.js'), /window\.DshImagePreview\?\.isOpen\?\.\(\)/)
})

async function until(check){for(let i=0;i<150;i++){if(check())return;await new Promise(setImmediate)}assert.fail('image did not settle')}
function persistent(h,db){
  Object.assign(h.window,{Blob,atob,indexedDB:db.indexedDB})
  vm.runInNewContext(read('public/image-cache.js'),{window:h.window,setTimeout,clearTimeout,Date,Map,Promise,JSON,Error})
}
test('persistent attachments skip the network after node reconstruction and release blob URLs',async()=>{
  const db=require('./fixtures/image-indexeddb.cjs')(),h=fixture(),id='a'.repeat(64),revoked=[];let calls=0
  persistent(h,db);h.window.URL.revokeObjectURL=url=>revoked.push(url)
  h.api.configure({capture:()=>({scope:'credential-hash',valid:()=>true}),resolveAttachment:async()=>{calls++;return {attachment:{attachmentId:id,mediaType:'image/png'},data:'AAAA'}}})
  for(let i=0;i<2;i++){
    const {button}=pathButton();delete button.dataset.chatImagePath
    Object.assign(button.dataset,{chatImageAttachment:id,chatImageSession:'S'})
    h.api.hydrate({querySelectorAll:selector=>selector.includes('attachment')?[button]:[]})
    await until(()=>button.dataset.chatImageLoaded)
    assert.equal(button.children[0].src,'blob:image')
  }
  assert.equal(calls,1);assert.equal((await h.window.DshImageCache.stats()).count,1)
  h.api.reset();assert.equal(revoked.length,2)
})
test('cached path images send validators and reuse the image body on 304',async()=>{
  const requests=[],db=require('./fixtures/image-indexeddb.cjs')(),h=fixture('zh',async(url,options)=>{
    requests.push(options)
    return requests.length===1?{ok:true,status:200,blob:async()=>new Blob(['image'],{type:'image/png'}),headers:{get:key=>key==='etag'?'"etag-1"':null}}:{ok:false,status:304}
  })
  persistent(h,db);h.api.configure({capture:()=>({scope:'credential-hash',valid:()=>true}),resolvePath:()=>({url:'http://host/fs/file?path=x',headers:{authorization:'Bearer private'}})})
  for(let i=0;i<2;i++){const {button}=pathButton();h.api.hydrate({querySelectorAll:()=>[button]});await until(()=>button.dataset.chatImageLoaded)}
  assert.equal(requests.length,2);assert.equal(requests[1].headers['If-None-Match'],'"etag-1"')
  assert.equal(requests[1].headers.authorization,'Bearer private');assert.equal((await h.window.DshImageCache.stats()).bytes,5)
  assert.doesNotMatch(JSON.stringify([...db.rows.values()]),/Bearer private/)
})
test('an identity switch during a file-image body read never paints or persists the old image',async()=>{
  let finish,valid=true,started=false
  const db=require('./fixtures/image-indexeddb.cjs')(),h=fixture('zh',async()=>({ok:true,blob:()=>new Promise(resolve=>{finish=resolve;started=true})}))
  persistent(h,db);h.api.configure({capture:()=>({scope:'old-credential',valid:()=>valid}),resolvePath:()=>({url:'http://host/fs/file?path=x'})})
  const {button}=pathButton();h.api.hydrate({querySelectorAll:()=>[button]});await until(()=>started)
  valid=false;finish(new Blob(['private'],{type:'image/png'}));await until(()=>db.rows.size===0)
  await new Promise(setImmediate)
  assert.equal(button.dataset.chatImageLoaded,undefined);assert.equal(db.rows.size,0)
})
