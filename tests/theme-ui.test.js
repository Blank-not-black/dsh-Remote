'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const css = read('public/theme-vars.css')

test('fresh, invalid and unavailable theme storage default to fish before paint and after initialization', () => {
  const pages = ['public/index.html', 'public/admin.html', 'public/plugin.html', 'public/desktop/desktop.html']
  const valid = ['default', 'dark', 'light', 'neutral', 'mono', 'fish', 'penguin', 'penguin-night', 'bocchi', 'nijika', 'ryo', 'kita']
  for (const saved of [null, 'obsolete', 'denied', ...valid]) {
    for (const light of [false, true]) {
      const expected = valid.includes(saved) ? saved : 'fish'
      let applied, writes = 0, selected
      const localStorage = {
        getItem() { if (saved === 'denied') throw Error('denied'); return selected ?? saved },
        setItem(key, value) { writes++; selected = value },
      }
      const document = {
        documentElement: { setAttribute(key, value) { assert.equal(key, 'data-theme'); applied = value } },
        querySelector() { return null },
      }
      const window = { matchMedia: () => ({ matches: light }), dispatchEvent() {} }
      window.parent = window
      const context = { window, document, localStorage, CustomEvent: class {},
        getComputedStyle: () => ({ getPropertyValue: () => '' }) }
      for (const page of pages) {
        const script = [...read(page).matchAll(/<script>([\s\S]*?)<\/script>/g)].find(match => match[1].includes('dshTheme'))[1]
        vm.runInNewContext(script, context)
        assert.equal(applied, expected, `${page}: ${saved}, light=${light}`)
      }
      vm.runInNewContext(read('public/theme.js'), context)
      assert.equal(applied, expected); assert.equal(window.DSHTheme.get(), expected)
      assert.equal(writes, 0, 'initialization preserves the stored preference')
      // Desktop has its own theme adapter, which must not remove the first-frame theme.
      const source = read('public/desktop/desktop.js')
      const begin = source.indexOf('const THEME_META ='), end = source.indexOf('/* ---------------- 状态', begin)
      vm.runInNewContext(source.slice(begin, end), { document, LS: { get: () => saved, set() {} },
        $: () => null, t: key => key })
      assert.equal(applied, expected, `desktop adapter: ${saved}`)
      window.DSHTheme.set('mono')
      assert.equal(applied, 'mono'); assert.equal(writes, 1)
    }
  }
})

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
  assert.match(themeJs, /\['default', 'dark', 'light', 'neutral', 'mono', 'fish', 'penguin', 'penguin-night', 'bocchi', 'nijika', 'ryo', 'kita'\]/)
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

test('蓝色大肥鱼主题贯穿主题存储、首帧脚本、客户端入口与皮肤样式表', () => {
  const themeJs = read('public/theme.js')
  assert.match(themeJs, /\['default', 'dark', 'light', 'neutral', 'mono', 'fish', 'penguin', 'penguin-night', 'bocchi', 'nijika', 'ryo', 'kita'\]/)
  for (const relative of [
    'public/index.html',
    'public/admin.html',
    'public/plugin.html',
    'public/desktop/desktop.html'
  ]) assert.match(read(relative), /t!==['"]fish['"]/, relative)
  for (const relative of ['public/app.js', 'public/admin.js', 'public/desktop/desktop.js']) {
    assert.match(read(relative), /id: 'fish', sw: \['#EAF6FF', '#FFFFFF', '#2F52D0'\]/, relative)
  }
  for (const relative of ['public/index.html', 'public/admin.html']) {
    assert.match(read(relative), /'theme\.fish': '蓝色大肥鱼'/, relative)
    assert.match(read(relative), /'theme\.fish': 'Blue Fat Fish'/, relative)
  }
  const desktopHtml = read('public/desktop/desktop.html')
  assert.match(desktopHtml, /'ds\.theme\.fish': '蓝色大肥鱼'/)
  assert.match(desktopHtml, /'ds\.theme\.fish': 'Blue Fat Fish'/)
  assert.match(desktopHtml, /'ds\.themeDesc': '默认深空 \/ 落日 \/ 易北爱乐厅 \/ 草原孤塔 \/ 黑曜白 \/ 蓝色大肥鱼 \/ 企鹅女管·白昼 \/ 企鹅女管·极夜 \/ 波奇酱 \/ 伊地知虹夏 \/ 山田凉 \/ 喜多郁代'/)
  assert.match(desktopHtml, /'ds\.themeDesc': 'Deep Space \/ Sunset \/ Elbphilharmonie \/ Prairie Tower \/ Monochrome \/ Blue Fat Fish \/ Penguin Admin Day \/ Penguin Admin Night \/ Bocchi \/ Nijika \/ Ryo \/ Kita'/)
  assert.match(read('scripts/sync-plugin.mjs'), /'skins'/)
  assert.match(read('public/index.html'), /href="skins\/blue-fish\/skin\.css"/)
  assert.match(read('public/plugin.html'), /href="skins\/blue-fish\/skin\.css"/)
  assert.match(read('public/admin.html'), /href="\.\.\/skins\/blue-fish\/skin\.css"/)
  assert.match(desktopHtml, /href="\.\.\/skins\/blue-fish\/skin\.css"/)
  assert.match(read('public/plugin.html'), /html\[data-theme="fish"\]/)
  const skin = read('public/skins/blue-fish/skin.css')
  assert.match(skin, /html\[data-theme="fish"\]/, 'skin.css should be scoped to the fish theme')
  assert.match(skin.slice(0, 240), /fish|大肥鱼/, 'skin.css header or first selector should name the fish skin')
  // 角色素材: 立绘/头像/背景瓦片必须随皮肤包一起存在, 且 skin.css 真正引用它们
  for (const asset of ['icon.png', 'icon-star.png', 'icon-wink.png', 'icon-sleep.png', 'icon-smile.png', 'icon-blush.png', 'face.png', 'mascot.png', 'pattern.png']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'skins', 'blue-fish', asset)), asset)
    assert.match(skin, new RegExp(`url\\("${asset}"\\)`), asset)
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'public', 'skins', 'blue-fish', 'preview.html')))
})

test('蓝色大肥鱼保持亮色底上的正文与弱化文字对比度', () => {
  const fish = themeBlock('fish')
  const bg = cssValue(fish, '--dsr-bg')
  const text = cssValue(fish, '--dsr-text')
  const muted = cssValue(fish, '--dsr-muted')
  const accent = cssValue(fish, '--dsr-accent')
  const onAccent = cssValue(fish, '--dsr-on-accent')
  assert.ok(contrast(text, bg) >= 7, 'primary text should meet enhanced contrast')
  assert.ok(contrast(muted, bg) >= 4.5, 'muted text should meet normal text contrast')
  assert.ok(contrast(onAccent, accent) >= 4.5, 'accent button should meet normal text contrast')
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

test('企鹅女管（白昼/极夜）主题贯穿主题存储、首帧脚本、客户端入口与皮肤样式表', () => {
  const themeJs = read('public/theme.js')
  assert.match(themeJs, /\['default', 'dark', 'light', 'neutral', 'mono', 'fish', 'penguin', 'penguin-night', 'bocchi', 'nijika', 'ryo', 'kita'\]/)
  for (const relative of [
    'public/index.html',
    'public/admin.html',
    'public/plugin.html',
    'public/desktop/desktop.html'
  ]) {
    assert.match(read(relative), /t!==['"]penguin['"]/, relative)
    assert.match(read(relative), /t!==['"]penguin-night['"]/, relative)
  }
  for (const relative of ['public/app.js', 'public/admin.js', 'public/desktop/desktop.js']) {
    assert.match(read(relative), /id: 'penguin', sw: \['#EDF3FA', '#FFFFFF', '#2B6CB0'\]/, relative)
    assert.match(read(relative), /id: 'penguin-night', sw: \['#10151B', '#1A222C', '#F2C230'\]/, relative)
  }
  for (const relative of ['public/index.html', 'public/admin.html']) {
    assert.match(read(relative), /'theme\.penguin': '企鹅女管·白昼'/, relative)
    assert.match(read(relative), /'theme\.penguin-night': '企鹅女管·极夜'/, relative)
    assert.match(read(relative), /'theme\.penguin': 'Penguin Admin Day'/, relative)
  }
  const desktopHtml = read('public/desktop/desktop.html')
  assert.match(desktopHtml, /'ds\.theme\.penguin': '企鹅女管·白昼'/)
  assert.match(desktopHtml, /'ds\.theme\.penguin-night': '企鹅女管·极夜'/)
  assert.match(desktopHtml, /'ds\.theme\.penguin': 'Penguin Admin Day'/)
  assert.match(desktopHtml, /'ds\.themeDesc': '默认深空 \/ 落日 \/ 易北爱乐厅 \/ 草原孤塔 \/ 黑曜白 \/ 蓝色大肥鱼 \/ 企鹅女管·白昼 \/ 企鹅女管·极夜 \/ 波奇酱 \/ 伊地知虹夏 \/ 山田凉 \/ 喜多郁代'/)
  assert.match(read('public/index.html'), /href="skins\/penguin\/skin\.css"/)
  assert.match(read('public/plugin.html'), /href="skins\/penguin\/skin\.css"/)
  assert.match(read('public/admin.html'), /href="\.\.\/skins\/penguin\/skin\.css"/)
  assert.match(desktopHtml, /href="\.\.\/skins\/penguin\/skin\.css"/)
  assert.match(read('public/plugin.html'), /html\[data-theme="penguin"\]/)
  const skin = read('public/skins/penguin/skin.css')
  assert.match(skin, /html:is\(\[data-theme="penguin"\], \[data-theme="penguin-night"\]\)/, 'skin.css should be scoped to both penguin themes')
  assert.match(skin.slice(0, 400), /企鹅|管理员/, 'skin.css header should name the penguin skin')
  // 角色素材: 表情/头像/立绘/背景瓦片必须随皮肤包一起存在, 且 skin.css 真正引用它们
  for (const asset of ['icon.png', 'icon-dizzy.png', 'icon-wink.png', 'icon-sleep.png', 'icon-smile.png', 'icon-blush.png', 'icon-laugh.png', 'face.png', 'mascot.png']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'skins', 'penguin', asset)), asset)
    assert.match(skin, new RegExp(`url\\("${asset}"\\)`), asset)
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'public', 'skins', 'penguin', 'preview.html')))
})

test('企鹅女管白昼/极夜均满足正文、弱化文字与主按钮对比度', () => {
  const light = themeBlock('penguin')
  const night = themeBlock('penguin-night')
  for (const [name, block] of [['penguin', light], ['penguin-night', night]]) {
    const bg = cssValue(block, '--dsr-bg')
    assert.ok(contrast(cssValue(block, '--dsr-text'), bg) >= 7, `${name}: primary text`)
    assert.ok(contrast(cssValue(block, '--dsr-muted'), bg) >= 4.5, `${name}: muted text`)
    assert.ok(contrast(cssValue(block, '--dsr-on-accent'), cssValue(block, '--dsr-accent')) >= 4.5, `${name}: accent button`)
  }
  assert.equal(cssValue(light, '--dsr-bg'), '#EDF3FA')
  assert.equal(cssValue(night, '--dsr-bg'), '#10151B')
  assert.equal(cssValue(night, '--dsr-accent'), '#F2C230')
  assert.match(css, /--pgn-beak:/)
})

test('波奇酱主题贯穿主题存储、首帧脚本、客户端入口与皮肤样式表', () => {
  const themeJs = read('public/theme.js')
  assert.match(themeJs, /\['default', 'dark', 'light', 'neutral', 'mono', 'fish', 'penguin', 'penguin-night', 'bocchi', 'nijika', 'ryo', 'kita'\]/)
  for (const relative of [
    'public/index.html',
    'public/admin.html',
    'public/plugin.html',
    'public/desktop/desktop.html'
  ]) assert.match(read(relative), /t!==['"]bocchi['"]/, relative)
  for (const relative of ['public/app.js', 'public/admin.js', 'public/desktop/desktop.js']) {
    assert.match(read(relative), /id: 'bocchi', sw: \['#FFD9E8', '#FFFFFF', '#D0105A'\]/, relative)
  }
  assert.match(read('public/index.html'), /'theme\.bocchi': '波奇酱'/)
  assert.match(read('public/index.html'), /'theme\.bocchi': 'Bocchi'/)
  assert.match(read('public/admin.html'), /'theme\.bocchi': '波奇酱'/)
  assert.match(read('public/desktop/desktop.html'), /'ds\.theme\.bocchi': '波奇酱'/)
  const desktopHtml = read('public/desktop/desktop.html')
  assert.match(desktopHtml, /'ds\.themeDesc': '默认深空 \/ 落日 \/ 易北爱乐厅 \/ 草原孤塔 \/ 黑曜白 \/ 蓝色大肥鱼 \/ 企鹅女管·白昼 \/ 企鹅女管·极夜 \/ 波奇酱 \/ 伊地知虹夏 \/ 山田凉 \/ 喜多郁代'/)
  assert.match(desktopHtml, /'ds\.themeDesc': 'Deep Space \/ Sunset \/ Elbphilharmonie \/ Prairie Tower \/ Monochrome \/ Blue Fat Fish \/ Penguin Admin Day \/ Penguin Admin Night \/ Bocchi \/ Nijika \/ Ryo \/ Kita'/)
  assert.match(read('public/index.html'), /href="skins\/bocchi\/skin\.css"/)
  assert.match(read('public/plugin.html'), /href="skins\/bocchi\/skin\.css"/)
  assert.match(read('public/admin.html'), /href="\.\.\/skins\/bocchi\/skin\.css"/)
  assert.match(read('public/admin.html'), /theme\.bocchi': 'Bocchi'/)
  assert.match(desktopHtml, /href="\.\.\/skins\/bocchi\/skin\.css"/)
  assert.match(read('public/plugin.html'), /html\[data-theme="bocchi"\]/)
  const skin = read('public/skins/bocchi/skin.css')
  assert.match(skin, /html\[data-theme="bocchi"\]/, 'skin.css should be scoped to the bocchi theme')
  assert.match(skin.slice(0, 400), /波奇|后藤一里/, 'skin.css header should name the bocchi skin')
  // 角色素材: 表情/头像/立绘/背景瓦片必须随皮肤包一起存在, 且 skin.css 真正引用它们
  for (const asset of ['icon.png', 'icon-star.png', 'icon-wink.png', 'icon-sleep.png', 'icon-smile.png',
    'icon-blush.png', 'face.png', 'pattern-soft.png', 'stand.png', 'grain.png']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'skins', 'bocchi', asset)), asset)
    assert.match(skin, new RegExp(`url\\("${asset}"\\)`), asset)
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'public', 'skins', 'bocchi', 'pattern.png')), 'pattern.png')
  assert.ok(fs.existsSync(path.join(ROOT, 'public', 'skins', 'bocchi', 'preview.html')))
})

test('波奇酱保持粉白底上的正文、弱化文字与主按钮对比度', () => {
  const block = themeBlock('bocchi')
  const bg = cssValue(block, '--dsr-bg')
  assert.ok(contrast(cssValue(block, '--dsr-text'), bg) >= 7, 'primary text should meet enhanced contrast')
  assert.ok(contrast(cssValue(block, '--dsr-muted'), bg) >= 4.5, 'muted text should meet normal text contrast')
  assert.ok(contrast(cssValue(block, '--dsr-on-accent'), cssValue(block, '--dsr-accent')) >= 4.5,
    'accent button should meet normal text contrast')
  assert.equal(bg, '#FFD9E8')
  assert.equal(cssValue(block, '--dsr-accent'), '#D0105A')
  assert.match(block, /color-scheme: light/)
})

test('虹夏、凉、喜多分别接入所有入口与中英文选择器，资源路径可独立解析', () => {
  for (const [id, name, en] of [['nijika', '伊地知虹夏', 'Nijika'], ['ryo', '山田凉', 'Ryo'], ['kita', '喜多郁代', 'Kita']]) {
    const block = themeBlock(id)
    for (const relative of ['public/app.js', 'public/admin.js', 'public/desktop/desktop.js']) {
      assert.ok(read(relative).includes(`{ id: '${id}', sw: ['${cssValue(block, '--dsr-bg')}', '#FFFFFF', '${cssValue(block, '--dsr-accent')}'] }`), relative)
    }
    for (const relative of ['public/index.html', 'public/admin.html', 'public/plugin.html', 'public/desktop/desktop.html']) {
      const source = read(relative)
      assert.ok(source.includes(`t!=='${id}'`), `${relative}: first paint`)
      assert.ok(source.includes(`skins/${id}/skin.css`), `${relative}: role stylesheet`)
      assert.ok(source.indexOf('skins/kessoku/skin.css') < source.indexOf(`skins/${id}/skin.css`), `${relative}: shared styles load first`)
      if (relative !== 'public/plugin.html') {
        assert.ok(source.includes(`theme.${id}': '${name}'`), `${relative}: Chinese label`)
        assert.ok(source.includes(`theme.${id}': '${en}'`), `${relative}: English label`)
      }
    }
    const skin = read(`public/skins/${id}/skin.css`)
    assert.ok(skin.includes(`html[data-theme="${id}"]`))
    for (const match of skin.matchAll(/url\("([^"\)]+)"\)/g)) {
      assert.ok(fs.existsSync(path.join(ROOT, 'public', 'skins', id, match[1])), `${id}: ${match[1]}`)
      assert.ok(fs.existsSync(path.join(ROOT, 'public', 'skins', 'kessoku', match[1])), `${id}: resource also resolves where the shared CSS consumes the variable`)
    }
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'skins', id, 'preview.html')))
    assert.ok(skin.includes(`.theme-option[data-theme="${id}"]`), 'preview colors belong to the option, not the current theme')
  }
})

test('虹夏、凉、喜多的纸面、辅助文字、按钮与导航标签达到阅读对比度要求', () => {
  for (const id of ['nijika', 'ryo', 'kita']) {
    const block = themeBlock(id)
    for (const background of ['--dsr-bg', '--btr-paper']) {
      assert.ok(contrast(cssValue(block, '--dsr-text'), cssValue(block, background)) >= 7, `${id}: ${background} body text`)
      assert.ok(contrast(cssValue(block, '--dsr-muted'), cssValue(block, background)) >= 4.5, `${id}: ${background} secondary text`)
    }
    assert.ok(contrast(cssValue(block, '--dsr-on-accent'), cssValue(block, '--dsr-accent')) >= 4.5, `${id}: primary button`)
    assert.ok(contrast(cssValue(block, '--dsr-nav-muted'), '#FFFFFF') >= 4.5, `${id}: inactive navigation label`)
    assert.match(block, /color-scheme: light/)
  }
})
