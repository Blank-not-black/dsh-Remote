'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
const styles = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8')
const gateway = fs.readFileSync(path.join(ROOT, 'gateway.js'), 'utf8')

test('投票公告提供选项、本地去重、历史入口和结构化提交', () => {
  assert.match(html, /id="overview-announcement-list"/)
  assert.match(html, /id="overview-announcement-history"/)
  assert.doesNotMatch(html, /id="overview-more"/)
  assert.doesNotMatch(html, /id="overview-announcement-board"[^>]*\bhidden\b/)
  assert.ok(html.indexOf('class="overview-pulse-card"') < html.indexOf('id="overview-announcement-board"'))
  assert.match(html, /id="announcement-poll"/)
  assert.match(html, /id="announcement-poll-options"/)
  assert.match(html, /id="announcement-poll-submit"/)
  assert.match(app, /ANNOUNCEMENT_VOTES_KEY/)
  assert.match(app, /function renderAnnouncementBoard\(/)
  assert.match(app, /filter\(item => !seen\[item\.id\]\)/)
  assert.match(app, /slice\(0, 1\)/)
  assert.match(app, /class="overview-empty"/)
  assert.match(app, /overview\.communityEmpty/)
  assert.match(app, /state\.announcements\s*=\s*normalized/)
  assert.match(app, /data-home-announcement=/)
  assert.match(app, /normalizeAnnouncementPoll/)
  assert.match(app, /data-announcement-poll=/)
  assert.match(app, /announcementId: item\.id/)
  assert.match(gateway, /function validatePollVote/)
  assert.match(gateway, /poll option not found/)
})

test('主页公告空状态常驻，设置页无漂浮右箭头且刷新图标居中', () => {
  assert.match(html, /'overview\.communityEmpty': '暂无未读公告'/)
  const settingsHome = html.match(/<div id="settings-home">([\s\S]*?)<div id="settings-page-general"/)?.[1] || ''
  assert.doesNotMatch(settingsHome, /class="sc-arrow"/)
  assert.match(styles, /\.overview-refresh\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;/)
})

test('公告以前台 30 秒轮询中央源，恢复可见或联网时立即补查', () => {
  assert.match(app, /ANNOUNCEMENTS_POLL_MS\s*=\s*30\s*\*\s*1000/)
  assert.match(app, /announcementCheckPromise/)
  assert.match(app, /setInterval\(\(\)\s*=>/)
  assert.match(app, /visibilitychange/)
  assert.match(app, /window\.addEventListener\('online'/)
  assert.match(app, /startAnnouncementPolling\(\)/)
  assert.match(gateway, /DEFAULT_ANNOUNCEMENTS_URL/)
  assert.match(gateway, /x-dsh-announcements-source/)
})

test('反馈仅在服务器确认成功后显示明确确认', () => {
  assert.match(html, /id="modal-feedback-success"/)
  assert.match(html, /id="feedback-success-confirm"/)
  assert.match(html, /data-i18n="feedback\.successBody"/)
  assert.match(app, /if \(res\.ok && json\.ok\) \{ closeFeedbackModal\(\); openFeedbackSuccess\(\) \}/)
  assert.match(app, /feedback-success-confirm'\)\.addEventListener\('click', closeFeedbackSuccess\)/)
  assert.match(app, /e\.target === \$\('modal-feedback-success'\)/)
})
