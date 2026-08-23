'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

test('投票汇总兼容结构化字段和旧收集器保留的 message', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-poll-summary-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'feedback.jsonl')
  fs.writeFileSync(file, [
    { type: 'poll', announcementId: 'roadmap', pollId: 'priority', optionId: 'files' },
    { type: 'poll', message: 'POLL {"announcementId":"roadmap","pollId":"priority","optionId":"files"}' },
    { type: 'poll', message: 'POLL {"announcementId":"roadmap","pollId":"priority","optionId":"stability"}' },
    { type: 'bug', message: 'ignore me' },
  ].map(value => JSON.stringify(value)).join('\n'))
  const output = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'summarize-polls.mjs'), file, '--json'], { encoding: 'utf8' })
  const result = JSON.parse(output)
  assert.equal(result.invalid, 0)
  assert.deepEqual(result.polls, [{
    announcementId: 'roadmap', pollId: 'priority', total: 3, options: { files: 2, stability: 1 },
  }])
})

