'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
const styles = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8')

test('手机设置页提供 DSH 模型配置入口和编辑区域', () => {
  assert.match(html, /data-settings-group="model"/)
  assert.match(html, /id="settings-page-model"/)
  assert.match(html, /id="model-settings-list"/)
  assert.match(styles, /\.model-settings-shell/)
  assert.match(styles, /\.model-provider-card/)
})

test('模型设置通过 DSH RPC 读取和保存，API key 不写入 WebView 存储', () => {
  for (const method of [
    'llm.providers',
    'settings.describe',
    'credentials.describe',
    'credentials.set',
    'credentials.unset',
    'settings.mutate',
    'llm.discoverModels',
    'settings.openDocument',
  ]) {
    assert.match(app, new RegExp(`(?:rpc|safeRpc)\\('${method.replace('.', '\\.')}'`))
  }

  assert.match(app, /data-model-field="apiKey" value=/)
  assert.doesNotMatch(app, /LS\.(?:get|set|del)\([^)]*apiKey/i)
  assert.doesNotMatch(app, /localStorage\.(?:getItem|setItem|removeItem)\([^)]*apiKey/i)
})

test('模型设置支持只写密钥、API 地址、模型目录编辑和模型发现', () => {
  assert.match(app, /type="password" autocomplete="off" data-model-field="apiKey"/)
  assert.match(app, /data-model-field="baseURL"/)
  assert.match(app, /rpc\('settings\.mutate'/)
  assert.match(app, /rpc\('credentials\.set'/)
  assert.match(app, /rpc\('credentials\.unset'/)
  assert.match(app, /rpc\('llm\.discoverModels'/)
  assert.match(app, /data-model-action="add-model"/)
  assert.match(app, /data-model-action="remove-model"/)
  assert.match(app, /data-model-action="add-selected"/)
})

test('自定义模型支持模型级思考档位和默认档位', () => {
  assert.match(app, /const MODEL_REASONING_LIMIT = 12/)
  assert.match(app, /const MODEL_REASONING_ID_RE = \/\^\[A-Za-z0-9\]/)
  assert.match(app, /function modelReasoningRows\(model\)/)
  assert.match(app, /function withModelReasoning\(model, rows, defaultEffort = ''\)/)
  assert.match(app, /data-model-field="reasoning-id"/)
  assert.match(app, /data-model-field="reasoning-name"/)
  assert.match(app, /data-model-field="reasoning-description"/)
  assert.match(app, /data-model-field="reasoning-default"/)
  assert.match(app, /data-model-action="add-reasoning"/)
  assert.match(app, /data-model-action="remove-reasoning"/)
  assert.match(app, /data-model-action="clear-reasoning"/)
  assert.match(app, /modelReasoningError\(models\)/)
  assert.match(app, /reasoning\.efforts = efforts/)
  assert.match(app, /delete next\.reasoningEfforts/)
  assert.match(app, /defaultEffort = modelObjectAt\(model, \['reasoning'\]\)\.defaultEffort/)
})
