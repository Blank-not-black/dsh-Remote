const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

for (const file of ['public/app.js', 'public/desktop/desktop.js']) {
  test(`${file}: only archive confirmed empty sessions, retain drafts, activity and failed reads`, async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    const code = source.slice(source.indexOf('const emptySessionCleanup'), source.indexOf('async function openSession'))
    for (const scenario of ['empty', 'message', 'unknown', 'draft', 'image', 'running', 'queue', 'sending', 'race', 'failure']) {
      const calls = []
      const session = { sessionId: 's', running: scenario === 'running' }
      const state = { current: 's', server: 'host', byId: new Map([['s', session]]), queues: {}, sessionActivity: new Set(), pendingPrompts: new Set(), composerImages: [] }
      if (scenario === 'image') state.composerImages.push({})
      if (scenario === 'queue') state.queues.s = [{}]
      if (scenario === 'sending') state.pendingPrompts.add('s')
      const c = {
        state, $: () => ({ value: scenario === 'draft' ? 'unfinished' : '' }),
        refreshSessions: async () => calls.push('refresh'),
        rpc: async method => {
          calls.push(method)
          if (method === 'workspace.archiveSession') return { archivedSessionIds: ['s'] }
          if (scenario === 'failure') throw Error('offline')
          if (scenario === 'race') state.pendingPrompts.add('s')
          if (scenario === 'unknown') return {}
          return { events: [{ event: { type: scenario === 'message' ? 'user/message' : 'permission/preset' } }], hasMore: false }
        },
      }
      vm.createContext(c); vm.runInContext(code, c)
      assert.equal(await c.archiveEmptySessionOnLeave('s'), scenario === 'empty', scenario)
      assert.equal(calls.includes('workspace.archiveSession'), scenario === 'empty', scenario)
    }
  })
}
