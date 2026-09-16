'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
test('功能测试保留导航与返回，移除 ASR 页面及专用桥', () => {
  const html = read('public/index.html')
  assert.match(html, /data-settings-group="tests"/)
  const page = html.split('id="settings-page-tests"')[1].split('id="settings-page-servers"')[0]
  assert.match(page, /data-settings-back/)
  assert.doesNotMatch(html + read('public/app.js'), /NativeAsrTest|asr-test|settings\.asrTest/)
  assert.doesNotMatch(read('android/app/src/main/java/com/dshremote/app/MainActivity.java'), /AsrTestBridge|SpeechRecognizer/)
})
