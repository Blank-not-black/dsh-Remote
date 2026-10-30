/* DSH Remote 皮肤系统 · 零依赖
 * 十二套皮肤: html[data-theme] = default(默认深空) | dark(落日) | light(易北爱乐厅) | neutral(草原孤塔) | mono(黑曜白) | fish(蓝色大肥鱼) | penguin(企鹅女管·白昼) | penguin-night(企鹅女管·极夜) | bocchi(波奇酱) | nijika(伊地知虹夏) | ryo(山田凉) | kita(喜多郁代)
 * 优先级: localStorage dshTheme > 蓝色大肥鱼（默认）
 * set() 写入用户显式选择; applyCurrent() 只应用，不覆盖已有选择。 */
'use strict'
;(function () {
  const KEY = 'dshTheme'
  const DEFAULT = 'fish'
  const VALID = ['default', 'dark', 'light', 'neutral', 'mono', 'fish', 'penguin', 'penguin-night', 'bocchi', 'nijika', 'ryo', 'kita']
  const mq = window.matchMedia('(prefers-color-scheme: light)')
  const store = {
    get(k) { try { return localStorage.getItem(k) } catch { return null } },
    set(k, v) { try { localStorage.setItem(k, v) } catch {} }
  }

  function system() {
    return mq.matches ? 'light' : 'default'
  }

  function get() {
    const saved = store.get(KEY)
    return VALID.includes(saved) ? saved : DEFAULT
  }

  function syncMeta() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--dsr-bg').trim()
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta && bg) meta.setAttribute('content', bg)
  }

  function announce(t) {
    window.dispatchEvent(new CustomEvent('dsh-theme-change', { detail: { theme: t } }))
    if (window.parent !== window) {
      window.parent.postMessage({ source: 'dsh-remote-theme', type: 'change', theme: t }, location.origin)
    }
  }

  function applyAttr(t) {
    document.documentElement.setAttribute('data-theme', t)
    syncMeta()
    announce(t)
  }

  function applyCurrent() {
    applyAttr(get())
    return get()
  }

  function set(t) {
    if (!VALID.includes(t)) t = get()
    store.set(KEY, t)
    applyAttr(t)
    return t
  }

  // One picker for mobile, admin and desktop. Assets resolve beside theme.js,
  // including when the admin page is served under /remote/.
  const assetBase = document.currentScript?.src
  const GROUPS = [
    { id: 'basic', zh: '基础配色', en: 'Essentials', themes: ['default', 'dark', 'light', 'neutral', 'mono'] },
    { id: 'fish', zh: '蓝色大肥鱼', en: 'Blue Fat Fish', themes: ['fish'] },
    { id: 'endfield', zh: '明日方舟：终末地', en: 'Arknights: Endfield', themes: ['penguin', 'penguin-night'] },
    { id: 'bocchi', zh: '孤独摇滚！', en: 'BOCCHI THE ROCK!', themes: ['bocchi', 'nijika', 'ryo', 'kita'] }
  ]
  const ART = {
    fish: 'blue-fish/mascot.png', penguin: 'penguin/mascot.png', 'penguin-night': 'penguin/mascot.png',
    bocchi: 'bocchi/stand.png', nijika: 'nijika/stand.png', ryo: 'ryo/stand.png', kita: 'kita/stand.png'
  }
  let picker = null

  function openPicker({ themes, current = get(), label, lang = 'zh', onSelect = set }) {
    if (picker?.open) return
    const en = lang === 'en'
    const node = (tag, className, text) => {
      const el = document.createElement(tag)
      if (className) el.className = className
      if (text != null) el.textContent = text
      return el
    }
    const dialog = node('dialog', 'dsr-theme-picker')
    picker = dialog
    dialog.setAttribute('aria-labelledby', 'dsr-theme-title')
    const header = node('div', 'dsr-theme-header')
    const title = node('h2', '', en ? 'Choose a skin' : '选择皮肤')
    title.id = 'dsr-theme-title'
    const close = node('button', 'dsr-theme-close', '×')
    close.type = 'button'
    close.setAttribute('aria-label', en ? 'Close' : '关闭')
    close.addEventListener('click', () => dialog.close())
    header.append(title, close)
    const hint = node('p', 'dsr-theme-hint', en ? 'Expand a collection to preview. Select a skin to apply it.' : '按 IP 展开查看预览，点击皮肤即可应用。')
    const body = node('div', 'dsr-theme-groups')
    for (const group of GROUPS) {
      const options = group.themes.map(id => themes.find(theme => theme.id === id)).filter(Boolean)
      if (!options.length) continue
      const details = node('details', 'dsr-theme-group')
      details.dataset.group = group.id
      details.open = options.some(theme => theme.id === current)
      const summary = node('summary')
      summary.append(node('span', 'dsr-theme-group-name', en ? group.en : group.zh),
        node('span', 'dsr-theme-count', String(options.length)))
      if (details.open) summary.append(node('span', 'dsr-theme-active', en ? 'Current' : '当前使用'))
      summary.append(node('span', 'dsr-theme-chevron', '⌄'))
      const grid = node('div', 'dsr-theme-grid')
      const images = []
      for (const theme of options) {
        const name = label(theme.id)
        const selected = theme.id === current
        const card = node('button', 'dsr-theme-card')
        card.type = 'button'
        card.dataset.theme = theme.id
        card.setAttribute('aria-pressed', String(selected))
        card.setAttribute('aria-label', (en ? 'Apply ' : '应用') + name)
        for (const [index, color] of theme.sw.entries()) card.style.setProperty('--preview-' + index, color)
        const preview = node('span', 'dsr-theme-preview')
        preview.setAttribute('aria-hidden', 'true')
        const mock = node('span', 'dsr-theme-mock')
        mock.append(node('i', 'dsr-theme-mock-title'), node('i', 'dsr-theme-mock-line'),
          node('i', 'dsr-theme-mock-line'), node('i', 'dsr-theme-mock-button'))
        preview.append(mock)
        if (ART[theme.id]) {
          const img = node('img', 'dsr-theme-art')
          img.alt = ''
          img.decoding = 'async'
          images.push({ img, path: ART[theme.id] })
          img.addEventListener('error', () => { img.remove() }, { once: true })
          preview.append(img)
        }
        const caption = node('span', 'dsr-theme-caption')
        caption.append(node('span', 'dsr-theme-name', name), node('span', 'dsr-theme-check', selected ? '✓' : ''))
        const swatches = node('span', 'dsr-theme-swatches')
        swatches.setAttribute('aria-hidden', 'true')
        for (const color of theme.sw) {
          const swatch = node('i')
          swatch.style.background = color
          swatches.append(swatch)
        }
        card.append(preview, caption, swatches)
        card.addEventListener('click', () => { onSelect(theme.id); dialog.close() })
        grid.append(card)
      }
      // Closed collections do not fetch their character artwork.
      const loadImages = () => {
        if (!details.open) return
        for (const { img, path } of images.splice(0)) img.src = new URL('skins/' + path, assetBase || document.baseURI).href
      }
      details.addEventListener('toggle', loadImages)
      details.append(summary, grid)
      body.append(details)
      loadImages()
    }
    dialog.append(header, hint, body)
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return
      const rect = dialog.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close()
    })
    dialog.addEventListener('close', () => { dialog.remove(); if (picker === dialog) picker = null }, { once: true })
    document.body.append(dialog)
    dialog.showModal()
    close.focus()
  }

  applyCurrent()
  window.DSHTheme = { KEY, DEFAULT, VALID, system, get, set, applyCurrent, openPicker }
})()
