'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../public/desktop/desktop.js'), 'utf8')
const start = source.indexOf('async function checkNotesOnStart()')
const end = source.indexOf('async function submitFeedback()', start)
assert.ok(start >= 0 && end > start, 'the actual desktop startup handler exists')
const handler = source.slice(start, end)

async function run(overrides = {}) {
  const calls = []
  const displayed = []
  let jsonReads = 0
  const response = {
    ok: true,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
    async json() { jsonReads++; return { version: '0.7.1', notes: 'Release notes' } },
    ...overrides,
  }
  const context = vm.createContext({
    Date,
    async fetch(url, options) { calls.push({ url, options }); return response },
    openNotesModal(info) { displayed.push(info) },
  })
  vm.runInContext(handler, context)
  await context.checkNotesOnStart()
  return { calls, displayed, jsonReads }
}

test('desktop notes request fresh JSON and pass release metadata to the existing dialog', async () => {
  const result = await run()
  assert.equal(result.calls.length, 1)
  assert.match(result.calls[0].url, /^\.\.\/update\.json\?t=\d+$/)
  assert.equal(result.calls[0].options.cache, 'no-store')
  assert.deepEqual(result.displayed, [{ version: '0.7.1', notes: 'Release notes' }])
})

test('desktop notes reject unsuccessful HTTP responses before parsing', async () => {
  const result = await run({ ok: false })
  assert.equal(result.jsonReads, 0)
  assert.deepEqual(result.displayed, [])
})

test('desktop notes reject redirected JSON before parsing', async () => {
  const result = await run({ redirected: true })
  assert.equal(result.jsonReads, 0)
  assert.deepEqual(result.displayed, [])
})

test('desktop notes reject HTML and missing Content-Type before parsing', async t => {
  for (const type of ['text/html', '']) {
    await t.test(type || 'missing header', async () => {
      const result = await run({ headers: new Headers(type ? { 'content-type': type } : {}) })
      assert.equal(result.jsonReads, 0)
      assert.deepEqual(result.displayed, [])
    })
  }
})

test('desktop notes ignore malformed JSON', async () => {
  const result = await run({ async json() { throw new SyntaxError('invalid JSON') } })
  assert.deepEqual(result.displayed, [])
})

test('desktop notes ignore missing metadata and empty versions', async t => {
  for (const [name, data] of [['null', null], ['string', 'notes'], ['array', []], ['missing version', {}], ['empty version', { version: '' }]]) {
    await t.test(name, async () => {
      const result = await run({ async json() { return data } })
      assert.deepEqual(result.displayed, [])
    })
  }
})

test('desktop notes tolerate a network failure without opening the dialog', async () => {
  let opened = false
  const context = vm.createContext({ Date, async fetch() { throw new TypeError('network failure') }, openNotesModal() { opened = true } })
  vm.runInContext(handler, context)
  await context.checkNotesOnStart()
  assert.equal(opened, false)
})

test('desktop notes response validation accepts unsigned metadata without claiming authenticity', async () => {
  const metadata = { version: '0.7.1', notes: 'Unsigned release notes', history: [] }
  const result = await run({ async json() { return metadata } })
  assert.deepEqual(result.displayed, [metadata])
})
