'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const source = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8').replaceAll('\r\n', '\n')

function extract(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert.ok(from >= 0 && to > from, start + ' -> ' + end)
  return source.slice(from, to)
}

test('groupToken reports a single credential and rejects mixed groups', () => {
  const context = vm.createContext({ state: { activeGroup: 'g', servers: [] } })
  vm.runInContext(extract('function groupServers(', 'function setCurrentAccessToken('), context)
  context.state.servers = [
    { url: 'http://a', token: 't1', group: 'g' },
    { url: 'http://b', token: 't1', group: 'g' },
    { url: 'http://c', token: 't2', group: 'h' },
  ]
  assert.equal(context.groupToken('g'), 't1')
  assert.equal(context.groupToken('h'), 't2')
  context.state.servers.push({ url: 'http://d', token: 't3', group: 'g' })
  assert.equal(context.groupToken('g'), '')
})

test('syncGroupToken updates one group, clears stale pairing links, and leaves other groups alone', () => {
  const context = vm.createContext({ state: { activeGroup: 'g', servers: [] } })
  vm.runInContext(extract('function groupServers(', 'function setCurrentAccessToken('), context)
  context.state.servers = [
    { url: 'http://a', token: 'old', group: 'g', cacheRelayPin: 'p', cacheRelayOrigin: 'https://relay' },
    { url: 'http://b', token: 'old', group: 'g' },
    { url: 'http://c', token: 'keep', group: 'h' },
  ]
  assert.equal(context.syncGroupToken('g', 'new'), 2)
  assert.deepEqual(context.state.servers.filter(s => s.group === 'g').map(s => s.token), ['new', 'new'])
  assert.equal('cacheRelayPin' in context.state.servers[0], false)
  assert.equal('cacheRelayOrigin' in context.state.servers[0], false)
  assert.equal(context.state.servers[2].token, 'keep')
})

test('changing the current token updates every address in its group', () => {
  const context = vm.createContext({
    state: {
      activeGroup: 'g', server: 'http://a', token: 'old',
      servers: [
        { id: 'a', url: 'http://a', token: 'old', group: 'g' },
        { id: 'b', url: 'http://b', token: 'old', group: 'g' },
        { id: 'c', url: 'http://c', token: 'other', group: 'h' },
      ],
    },
    LS: { set() {} },
    saveServers() {},
  })
  vm.runInContext(extract('function groupServers(', 'function setCurrentAccessToken(') +
    '\n' + extract('function setCurrentAccessToken(', '/** 旧结构迁移'), context)
  context.setCurrentAccessToken('new')
  assert.equal(context.state.token, 'new')
  assert.deepEqual(context.state.servers.filter(s => s.group === 'g').map(s => s.token), ['new', 'new'])
  assert.equal(context.state.servers.find(s => s.id === 'c').token, 'other')
})

test('addServer refuses a mixed-token group and otherwise reuses the group token', async () => {
  const notices = []
  const context = vm.createContext({
    URL,
    I18N: { lang: 'zh' },
    t: key => key,
    state: {
      activeGroup: 'g', server: 'http://a', token: 'current',
      servers: [
        { id: 'a', url: 'http://a', token: 't1', group: 'g' },
        { id: 'b', url: 'http://b', token: 't2', group: 'g' },
      ],
    },
    $: () => ({ value: 'http://new' }),
    prompt: () => '',
    toast: (text, kind) => notices.push([text, kind]),
    newServerId: () => 'new-id',
    saveServers() {},
    renderServers() {},
    selectFastestServer() {},
  })
  vm.runInContext(extract('function groupServers(', 'function setCurrentAccessToken(') +
    '\n' + extract('async function addServer()', 'function editServer('), context)
  await context.addServer()
  assert.equal(context.state.servers.length, 2)
  assert.match(notices.at(-1)[0], /令牌不一致/)
  context.state.servers = [
    { id: 'a', url: 'http://a', token: 'group-token', group: 'g' },
  ]
  await context.addServer()
  assert.equal(context.state.servers.length, 2)
  assert.equal(context.state.servers[1].token, 'group-token')
})

test('editing one address applies its new token to the whole group', () => {
  const answers = ['http://a', 'new-token', '', 'g']
  const context = vm.createContext({
    URL,
    I18N: { lang: 'zh' },
    t: key => key,
    state: {
      activeGroup: 'g', server: 'http://a', token: 'old',
      servers: [
        { id: 'a', url: 'http://a', token: 'old', group: 'g', cacheRelayPin: 'p' },
        { id: 'b', url: 'http://b', token: 'old', group: 'g' },
        { id: 'c', url: 'http://c', token: 'keep', group: 'h' },
      ],
    },
    prompt: () => answers.shift(),
    toast() {},
    saveServers() {},
    renderServers() {},
    selectFastestServer() {},
    resetFsForServer() {},
    LS: { set() {} },
    ensureGroup: name => name,
  })
  vm.runInContext(extract('function groupServers(', 'function setCurrentAccessToken(') +
    '\n' + extract('function editServer(', 'function removeServer('), context)
  context.editServer('a')
  assert.deepEqual(context.state.servers.filter(s => s.group === 'g').map(s => s.token), ['new-token', 'new-token'])
  assert.equal(context.state.servers.find(s => s.id === 'c').token, 'keep')
  assert.equal('cacheRelayPin' in context.state.servers.find(s => s.id === 'a'), false)
})

test('the group header exposes a repair action only for mixed tokens', () => {
  assert.match(source, /data-sync-group="\$\{esc\(g\)\}"/)
  assert.match(source, /本组地址令牌不一致/)
  assert.match(source, /syncGroupToken\(group, token\)/)
  assert.match(source, /Editing one address changes the credential for the whole group/)
})
