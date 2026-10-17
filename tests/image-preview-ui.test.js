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

test('both shells render chat images as preview buttons and share the lightbox markup', () => {
  for (const file of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = read(file)
    assert.match(source, /class="chat-image" data-chat-image aria-label=/, file)
    assert.match(source, /data:.*mediaType.*base64/, file)
    assert.match(source, /function chatImageRequest\(pathValue\)/, file)
    assert.match(source, /window\.DshImagePreview\?\.configure\?\.\(\{ resolvePath: chatImageRequest \}\)/, file)
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
