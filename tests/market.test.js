'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const modulePromise = import('../packages/plugin/market.mjs')
const url = 'https://index.example/catalog.json', query = { text: '费用', sort: { kind: 'relevance' }, offset: 0, limit: 20 }
function fixture(overrides = {}, options) {
  const calls = [], service = { listIndexes: () => [{ url, title: { zh: '目录' } }], search: async (...args) => { calls.push(args); return { title: { zh: '目录' }, metadata: { categories: { cost: { title: { zh: '费用' } } } }, fetchedAt: 123, total: 25, nextOffset: 20, entries: [{ name: 'dsh-cost-meter', defaultVersion: '1.8.17', title: { zh: '费用' }, description: { en: 'Costs' }, metadata: { category: 'cost' }, installation: { status: 'installed', installedVersion: '1.8.17' }, versions: [{ version: '1.8.17', compatibility: { compatible: true } }] }] } }, ...overrides }
  return { calls, service, ctx: { get: name => name === 'pluginMarket' ? service : null }, options }
}
test('official market distinguishes missing service, unsupported methods, and no indexes without fetching', async () => {
  const { createMarketAdapter } = await modulePromise
  assert.equal((await createMarketAdapter({}).indexes()).code, 'not-installed')
  assert.equal((await createMarketAdapter({ get: () => ({}) }).indexes()).code, 'unsupported')
  const h = fixture({ listIndexes: () => [] }), adapter = createMarketAdapter(h.ctx)
  assert.equal((await adapter.search('', query)).code, 'no-indexes'); assert.equal(h.calls.length, 0)
})
test('official market forwards query and cursor, caps entries, and uses host installation/compatibility facts', async () => {
  const { createMarketAdapter } = await modulePromise, h = fixture(), adapter = createMarketAdapter(h.ctx)
  const result = await adapter.search('', { ...query, fetchedAt: 123 })
  assert.equal(result.available, true); assert.equal(result.source, 'official'); assert.equal(result.nextOffset, 20); assert.equal(result.categories[0].id, 'cost')
  assert.equal(result.items[0].installation.status, 'installed'); assert.equal(result.items[0].compatibility.compatible, true); assert.equal(h.calls[0][0], url); assert.equal(h.calls[0][1].fetchedAt, 123)
})
test('official market rejects unconfigured addresses and invalid query/sort shapes without upstream search', async () => {
  const { createMarketAdapter } = await modulePromise, h = fixture(), adapter = createMarketAdapter(h.ctx)
  assert.equal((await adapter.search('http://127.0.0.1/private', query)).code, 'unknown-index')
  for (const change of [{ offset: -1 }, { limit: 101 }, { limit: 0 }, { labels: ['x'.repeat(101)] }, { sort: { kind: 'published', direction: 'bad' } }, { sort: { kind: 'index', id: 'x' } }, { sort: { kind: 'key', direction: 'asc' } }, { refresh: 'true' }, { unknown: 1 }]) assert.equal((await adapter.search(url, { ...query, ...change })).code, 'invalid-query')
  assert.equal(h.calls.length, 0)
  for (const sort of [{ kind: 'index' }, { kind: 'relevance' }, { kind: 'published', direction: 'desc' }, { kind: 'key', id: 'downloads', direction: 'asc' }]) assert.equal((await adapter.search(url, { ...query, sort })).available, true)
})
test('official errors, failed indexes and timeout return fixed codes without host details', async () => {
  const { createMarketAdapter } = await modulePromise
  const secret = 'C:/private/token https://secret.invalid/?key=hidden'
  for (const overrides of [{ search: () => { throw Error(secret) } }, { listIndexes: () => { throw Error(secret) } }, { listIndexes: () => [{ url, error: secret }] }, { search: () => new Promise(() => {}) }]) {
    const h = fixture(overrides), result = await createMarketAdapter(h.ctx, { timeoutMs: 10 }).search('', query)
    assert.equal(result.available, false); assert.doesNotMatch(JSON.stringify(result), /private|secret|hidden/)
  }
})
test('README uses a bounded package cache, truncates content, distinguishes absence and never echoes registry errors', async () => {
  const { createReadmeReader } = await modulePromise; let calls = 0
  const read = createReadmeReader(async () => { calls++; return { name: 'example', readme: 'x'.repeat(100001), 'dist-tags': { latest: '2.0.0' } } })
  const result = await read('example', '1.0.0'); assert.equal(result.content.length, 100000); assert.equal(result.truncated, true); assert.equal(result.version, '2.0.0')
  await read('example'); assert.equal(calls, 1); assert.equal((await read('../private')).code, 'invalid-name')
  assert.equal((await createReadmeReader(async () => ({ name: 'example' }))('example')).code, 'no-readme')
  const failed = await createReadmeReader(async () => { throw Error('https://secret.invalid/token') })('example')
  assert.deepEqual(failed, { ok: false, code: 'readme-unavailable' })
})
test('strict README image policy rejects credentials, same-origin API, local paths, data, and unapproved hosts in all Markdown structures', () => {
  const md = require('../public/md.js'), options = { imageHosts: ['img.shields.io'], fileLinks: false, richContent: false }
  assert.match(md('![x](https://img.shields.io/x)', options), /referrerpolicy="no-referrer"/)
  for (const target of ['/api/private', 'data:image/svg+xml;base64,AAAA', 'file:///D:/x.png', 'x.png', 'https://evil.invalid/x', 'http://img.shields.io/x', 'https://user:secret@img.shields.io/x']) {
    for (const prefix of ['', '# ', '> ', '- ']) assert.doesNotMatch(md(prefix + '![x](' + target + ')', options), /<img|data-chat-image-path|src=/)
  }
  assert.doesNotMatch(md('| A | B |\n| --- | --- |\n| ![x](/api/private) | x |', options), /<img/)
  assert.match(md('![x](/api/private)'), /<img/)
})
