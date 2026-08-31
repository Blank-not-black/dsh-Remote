'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

test('应用名可打开可访问的组快捷切换抽屉，手机和桌面共用现有切换逻辑', () => {
  const mobileHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
  const mobileJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
  const mobileCss = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8')
  const desktopHtml = fs.readFileSync(path.join(ROOT, 'public', 'desktop', 'desktop.html'), 'utf8')
  const desktopJs = fs.readFileSync(path.join(ROOT, 'public', 'desktop', 'desktop.js'), 'utf8')
  const desktopCss = fs.readFileSync(path.join(ROOT, 'public', 'desktop', 'desktop.css'), 'utf8')

  assert.match(mobileHtml, /id="group-drawer-trigger"[^>]+aria-controls="group-drawer"[^>]+aria-expanded="false"/)
  assert.match(mobileHtml, /id="group-drawer"[^>]+role="dialog"[^>]+aria-modal="true"/)
  assert.match(mobileHtml, /id="group-drawer-manage"/)
  assert.match(mobileJs, /function renderGroupDrawer\(\)/)
  assert.match(mobileJs, /data-quick-group=/)
  assert.match(mobileJs, /function keepGroupDrawerFocus\(event\)/)
  assert.match(mobileJs, /if \(group !== state\.activeGroup\) switchGroup\(group\)/)
  assert.match(mobileJs, /showSettingsPage\('servers'\)/)
  assert.match(mobileCss, /\.group-drawer \{[^}]*position: fixed/)
  assert.match(mobileCss, /@media \(prefers-reduced-motion: reduce\)/)

  assert.match(desktopHtml, /id="ds-group-drawer-trigger"[^>]+aria-controls="ds-group-drawer"[^>]+aria-expanded="false"/)
  assert.match(desktopHtml, /id="ds-group-drawer"[^>]+role="dialog"[^>]+aria-modal="true"/)
  assert.match(desktopHtml, /id="ds-group-drawer-manage"/)
  assert.match(desktopJs, /function renderDesktopGroupDrawer\(\)/)
  assert.match(desktopJs, /data-ds-quick-group=/)
  assert.match(desktopJs, /function keepDesktopGroupDrawerFocus\(event\)/)
  assert.match(desktopJs, /if \(group !== state\.activeGroup\) switchGroup\(group\)/)
  assert.match(desktopCss, /\.ds-group-drawer \{[^}]*position: fixed/)
  assert.match(desktopCss, /@media \(prefers-reduced-motion: reduce\)/)
})
