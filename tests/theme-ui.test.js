'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const css = read('public/theme-vars.css')

function themeBlock(id) {
  const marker = `html[data-theme="${id}"] {`
  const start = css.lastIndexOf(marker)
  assert.notEqual(start, -1, `missing ${id} theme`)
  const open = css.indexOf('{', start)
  let depth = 1
  let index = open + 1
  for (; depth && index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    else if (css[index] === '}') depth -= 1
  }
  return css.slice(open + 1, index - 1)
}

function cssValue(block, name) {
  const match = block.match(new RegExp(`${name}:\\s*([^;]+);`))
  assert.ok(match, `${name} missing`)
  return match[1].trim()
}

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/ig).map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

test('黑曜白主题贯穿主题存储、首帧脚本和所有客户端入口', () => {
  const themeJs = read('public/theme.js')
  assert.match(themeJs, /\['default', 'dark', 'light', 'neutral', 'mono'\]/)
  for (const relative of [
    'public/index.html',
    'public/admin.html',
    'public/plugin.html',
    'public/desktop/desktop.html'
  ]) assert.match(read(relative), /t!==['"]mono['"]/, relative)
  for (const relative of ['public/app.js', 'public/admin.js', 'public/desktop/desktop.js']) {
    assert.match(read(relative), /id: 'mono', sw: \['#050505', '#333333', '#F5F5F5'\]/, relative)
  }
  assert.match(read('public/index.html'), /'theme\.mono': '黑曜白'/)
  assert.match(read('public/index.html'), /'theme\.mono': 'Monochrome'/)
  assert.match(read('public/admin.html'), /'theme\.mono': '黑曜白'/)
  assert.match(read('public/desktop/desktop.html'), /'ds\.theme\.mono': '黑曜白'/)
})

test('黑曜白保持纯灰阶并满足正文与弱化文字对比度', () => {
  const mono = themeBlock('mono')
  const bg = cssValue(mono, '--dsr-bg')
  const text = cssValue(mono, '--dsr-text')
  const muted = cssValue(mono, '--dsr-muted')
  const accent = cssValue(mono, '--dsr-accent')
  const onAccent = cssValue(mono, '--dsr-on-accent')
  assert.ok(contrast(text, bg) >= 7, 'primary text should meet enhanced contrast')
  assert.ok(contrast(muted, bg) >= 4.5, 'muted text should meet normal text contrast')
  assert.ok(contrast(onAccent, accent) >= 7, 'accent button should meet enhanced contrast')
  for (const value of mono.match(/#[0-9A-Fa-f]{6}/g) || []) {
    const [, r, g, b] = value.match(/#(..)(..)(..)/)
    assert.equal(r.toLowerCase(), g.toLowerCase(), `${value} is not grayscale`)
    assert.equal(g.toLowerCase(), b.toLowerCase(), `${value} is not grayscale`)
  }
  assert.match(css, /html\[data-theme="mono"\] body[\s\S]{0,220}radial-gradient/)
})

test('落日、易北爱乐厅和草原孤塔采用优化后的表面与文字层级', () => {
  const base = themeBlock('default')
  const dark = themeBlock('dark')
  const light = themeBlock('light')
  const neutral = themeBlock('neutral')
  assert.equal(cssValue(base, '--dsr-bg'), '#0D1117')
  assert.equal(cssValue(base, '--dsr-panel'), '#161B22')
  assert.equal(cssValue(base, '--dsr-accent'), '#58A6FF')
  assert.equal(cssValue(base, '--dsr-accent-2'), '#A5D6FF')
  assert.equal(cssValue(dark, '--dsr-bg'), '#161316')
  assert.equal(cssValue(dark, '--dsr-muted'), '#D2BEB0')
  assert.equal(cssValue(light, '--dsr-bg'), '#F5F7F8')
  assert.equal(cssValue(light, '--dsr-muted'), '#52616A')
  assert.equal(cssValue(light, '--dsr-nav-bg'), 'rgba(255, 255, 255, .96)')
  assert.equal(cssValue(neutral, '--dsr-bg'), '#EEF1E8')
  assert.equal(cssValue(neutral, '--dsr-accent'), '#47643C')
  assert.equal(cssValue(neutral, '--dsr-nav-bg'), 'rgba(250, 251, 246, .96)')
  for (const block of [base, dark, light, neutral]) {
    assert.ok(contrast(cssValue(block, '--dsr-text'), cssValue(block, '--dsr-bg')) >= 7)
    assert.ok(contrast(cssValue(block, '--dsr-muted'), cssValue(block, '--dsr-bg')) >= 4.5)
    assert.ok(contrast(cssValue(block, '--dsr-on-accent'), cssValue(block, '--dsr-accent')) >= 4.5)
  }
  assert.match(read('public/styles.css'), /\.theme-panel-list \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
  for (const relative of ['public/app.js', 'public/admin.js']) {
    assert.match(read(relative), /aria-pressed="\$\{m\.id === cur\}"/, relative)
  }
  for (const relative of ['public/app.js', 'public/admin.js', 'public/desktop/desktop.js']) {
    const source = read(relative)
    assert.match(source, /id: 'default', sw: \['#0D1117', '#21262D', '#58A6FF'\]/, relative)
    assert.match(source, /id: 'light', sw: \['#F5F7F8', '#FFFFFF', '#176B87'\]/, relative)
    assert.match(source, /id: 'neutral', sw: \['#EEF1E8', '#FAFBF6', '#47643C'\]/, relative)
  }
})

test('底部导航统一主题色，主页球保持双主色且设置齿轮内外同心', () => {
  const styles = read('public/styles.css')
  const desktopStyles = read('public/desktop/desktop.css')
  const mobileHtml = read('public/index.html')
  const desktopHtml = read('public/desktop/desktop.html')
  assert.doesNotMatch(styles, /\.nav-btn:nth-of-type\([^)]*\)\s*\{\s*--nav-tint/)
  assert.match(styles, /\.nav-btn:not\(\.nav-home\) \.nav-ico \{ color: var\(--dsr-nav-muted\)/)
  assert.match(styles, /\.nav-btn\.active:not\(\.nav-home\) \.nav-ico \{ color: var\(--dsr-nav-active\)/)
  assert.match(styles, /\.nav-home\.active \.nav-home-orb \{ background: linear-gradient\(145deg, var\(--dsr-accent-2\), var\(--dsr-accent\) 64%\)/)
  assert.doesNotMatch(styles, /\.nav-home\.active \.nav-home-orb[^}]+var\(--dsr-info\)/)
  for (const html of [mobileHtml, desktopHtml]) {
    assert.match(html, /class="settings-gear"[\s\S]{0,200}M12\.22 2h-\.44/)
    assert.match(html, /class="settings-gear"[\s\S]{0,1200}<circle cx="12" cy="12" r="3"/)
  }
  assert.doesNotMatch(styles, /view-settings[^}]+transform: translate/)
  assert.doesNotMatch(desktopStyles, /view-settings[^}]+transform: translate/)
})
