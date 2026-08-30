'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const CLIENT = path.join(ROOT, 'packages', 'plugin', 'client.js')

function loadFactory() {
  let registration
  const window = {
    __ModuleLoader__: {
      load(value) { registration = value },
    },
  }
  vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), { window, Symbol })
  assert.equal(registration?.id, 'dsh-remote-plugin')
  return registration.factory
}

test('插件客户端兼容新版 DSH 的 client-store 平台模块', () => {
  const requests = []
  const defineStore = () => ({})
  const plugin = loadFactory()((name) => {
    requests.push(name)
    if (name === 'react') return {}
    if (name === '@deepseek-ai/dsh-client-store') return { defineStore }
    throw new Error(`unexpected module ${name}`)
  })
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(requests, ['react', '@deepseek-ai/dsh-client-store'])
})

test('插件客户端在旧版 DSH 回退到 client-runtime', () => {
  const requests = []
  const defineStore = () => ({})
  const plugin = loadFactory()((name) => {
    requests.push(name)
    if (name === 'react') return {}
    if (name === '@deepseek-ai/dsh-client-store') throw new Error('module unavailable')
    if (name === '@deepseek-ai/dsh-client-runtime/client') return { defineStore }
    throw new Error(`unexpected module ${name}`)
  })
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(requests, [
    'react',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-runtime/client',
  ])
})
