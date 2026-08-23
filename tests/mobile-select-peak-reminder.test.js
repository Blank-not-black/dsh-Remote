'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
const styles = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8')
const peakService = fs.readFileSync(path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'dshremote', 'app', 'PeakReminderService.java'), 'utf8')

test('手机端所有原生 select 都由统一应用内选择抽屉接管', () => {
  const selectIds = Array.from(html.matchAll(/<select\s+id="([^"]+)"/g), match => match[1])
  assert.deepEqual(selectIds.sort(), [
    'bg-interval',
    'fs-workspace',
    'mobile-enter-action',
    'new-session-workspace',
    'session-sort',
    'session-workspace-filter'
  ])
  assert.match(html, /id="custom-select-sheet"/)
  assert.match(html, /id="custom-select-options"[^>]+role="listbox"/)
  assert.match(app, /document\.querySelectorAll\('select'\)\.forEach\(enhanceCustomSelect\)/)
  assert.match(app, /select\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/)
  assert.match(app, /customSelectOptionCopy\(option\)/)
  assert.match(app, /name\.textContent =/)
  assert.match(styles, /\.custom-select-native[\s\S]*pointer-events: none/)
  assert.match(styles, /\.custom-select-sheet[\s\S]*flex-direction: column/)
})

test('周末全天谷时且每天只在 09:00 提醒一次', () => {
  assert.match(peakService, /WEEKEND_REMINDER_TEXT = "今天是周末，谷时已到"/)
  assert.match(peakService, /Calendar\.SATURDAY \|\| day == Calendar\.SUNDAY/)
  assert.match(peakService, /if \(weekend && slotIndex != 0\) continue;/)
  assert.match(peakService, /String text = weekend \? WEEKEND_REMINDER_TEXT : \(String\) slot\[3\]/)
  assert.match(html, /周末全天谷时，仅 9:00 提醒一次/)
})

test('峰谷通知先持久化占位并在失败时回滚，启动时清理旧版重复计划', () => {
  const reserveIndex = peakService.indexOf('putString(key, today).commit()')
  const notifyIndex = peakService.indexOf('notifyPeak(id, text)')
  assert.ok(reserveIndex >= 0 && notifyIndex > reserveIndex, '必须在通知前同步写入每日去重标记')
  assert.match(peakService, /prefs\.edit\(\)\.remove\(key\)\.commit\(\)/)
  assert.match(app, /LEGACY_PEAK_NOTIFICATION_IDS = \[8801, 8802, 8803, 8804\]/)
  assert.match(app, /notifications\.cancel\(\{ notifications: LEGACY_PEAK_NOTIFICATION_IDS\.map/)
  assert.match(app, /async function restorePeakReminders\(\)[\s\S]*cancelLegacyPeakNotifications\(\)/)
  assert.match(app, /\/\/ 启动时先清理旧版 LocalNotifications[\s\S]*restorePeakReminders\(\)/)
})
