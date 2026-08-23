'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
const gateway = fs.readFileSync(path.join(ROOT, 'gateway.js'), 'utf8')

test('投票公告提供选项、本地去重、历史入口和结构化提交', () => {
  assert.match(html, /id="announcement-poll"/)
  assert.match(html, /id="announcement-poll-options"/)
  assert.match(html, /id="announcement-poll-submit"/)
  assert.match(app, /ANNOUNCEMENT_VOTES_KEY/)
  assert.match(app, /normalizeAnnouncementPoll/)
  assert.match(app, /data-announcement-poll=/)
  assert.match(app, /announcementId: item\.id/)
  assert.match(gateway, /function validatePollVote/)
  assert.match(gateway, /poll option not found/)
})
