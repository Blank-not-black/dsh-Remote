'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
const styles = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8')
const peakService = fs.readFileSync(path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'dshremote', 'app', 'PeakReminderService.java'), 'utf8')

test('手机端所有原生 select 都由统一应用内选择抽屉接管', () => {
  const selectIds = Array.from(html.matchAll(/<select\s+id="([^"]+)"/g), match => match[1])
  assert.deepEqual(selectIds.sort(), [
    'bg-interval',
    'busy-send-mode',
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

test('峰谷提醒交给费用插件，升级清理旧服务和调度', () => {
  assert.match(html, /dsh-cost-meter/)
  assert.doesNotMatch(html, /id="opt-peak-remind"/)
  assert.doesNotMatch(app, /schedulePeakReminders|startPeakReminder\(/)
  assert.match(app, /async function restorePeakReminders\(\)[\s\S]*?LS.del\('peakRemind'\)[\s\S]*?await cancelPeakReminders\(\)/)
  assert.match(app, /LEGACY_PEAK_NOTIFICATION_IDS = \[8801, 8802, 8803, 8804\]/)
  assert.match(peakService, /stopSelf\(\);[\s\S]*START_NOT_STICKY/)
  assert.doesNotMatch(peakService, /HandlerThread|Calendar|START_STICKY/)
  const activity = fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/com/dshremote/app/MainActivity.java'), 'utf8')
  assert.match(activity, /super.onCreate\(savedInstanceState\);[\s\S]*?stopService\(new Intent\(this, PeakReminderService.class\)\)/)
})

test('升级迁移删除旧开关并取消遗留通知，不启动新计时器', async () => {
  for (const bridge of [true, false]) {
    const calls = []
    const source = app.slice(app.indexOf('const LEGACY_PEAK_NOTIFICATION_IDS'), app.indexOf('/* ---------------- 模型设置'))
    const context = vm.createContext({
      CAP: { isNativePlatform: () => true, Plugins: { LocalNotifications: { cancel: async value => calls.push(['cancel', value.notifications.map(row => row.id)]) } } },
      LS: { del: key => calls.push(['delete', key]) },
      bgBridge: () => bridge ? { stopPeakReminder: () => { calls.push(['stop']); return true } } : null,
      console,
    })
    await vm.runInContext(source + '\nrestorePeakReminders()', context)
    assert.equal(JSON.stringify(calls), JSON.stringify([
      ['delete', 'peakRemind'], ['cancel', [8801, 8802, 8803, 8804]], ...(bridge ? [['stop']] : []),
    ]))
  }
})
