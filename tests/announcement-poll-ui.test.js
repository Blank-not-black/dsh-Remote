'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
const styles = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8')
const gateway = fs.readFileSync(path.join(ROOT, 'gateway.js'), 'utf8')

function announcementRuntime() {
  const source = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)))
  const seen = new Map(), hidden = new Set(['modal-announcement', 'modal-app-version-warning'])
  const runtime = {
    state: { localVersion: '0.8.0-rc.2', announcement: null, announcementItems: [] },
    window: { DshWorkflow: { isMounted: () => true } },
    payload: { items: [] }, opens: 0, requests: 0, duringFetch: null,
    URL, AbortSignal,
    LS: { get: (key, fallback) => seen.get(key) ?? fallback, set: (key, value) => seen.set(key, value) },
    $: id => ({ classList: { add: () => hidden.add(id), remove: () => { hidden.delete(id); if (id === 'modal-announcement') runtime.opens++ } } }),
    updateBase: () => 'https://gateway.example',
    isAppVersionWarningOpen: () => !hidden.has('modal-app-version-warning'),
    storeAnnouncementHistory: () => {}, renderAnnouncementBoard: () => {},
    renderAnnouncementModal: () => { runtime.state.announcement = runtime.state.announcementItems[0] },
    fetch: async () => {
      runtime.requests++
      runtime.duringFetch?.()
      return { ok: true, text: async () => JSON.stringify(runtime.payload) }
    }
  }
  vm.createContext(runtime)
  vm.runInContext([
    source("const ANNOUNCEMENTS_KEY =", 'function readAnnouncementVotes()'),
    source('function announcementVersionMatch(', 'function renderAnnouncementPoll('),
    source('function openAnnouncementModal(', 'function showAnnouncementAt('),
    source('function closeAnnouncement(', '\nfunction checkAnnouncements()')
  ].join('\n'), runtime)
  runtime.warning = visible => visible ? hidden.delete('modal-app-version-warning') : hidden.add('modal-app-version-warning')
  return runtime
}

test('新界面也自动弹出未读公告，已打开和确认已读后轮询均不重复弹出', async () => {
  const ui = announcementRuntime()
  ui.payload.items = [{ id: 'new', title: '新公告', content: '正文', publishedAt: '2026-01-01T00:00:00Z' }]
  assert.equal(await ui.fetchAnnouncements(), true)
  assert.equal(ui.opens, 1)
  assert.equal(await ui.fetchAnnouncements(), false)
  assert.equal(ui.opens, 1)
  ui.closeAnnouncement(true)
  assert.equal(await ui.fetchAnnouncements(), false)
  ui.payload.items.push({ id: 'newer', title: '更新公告', content: '正文', publishedAt: '2026-01-02T00:00:00Z' })
  assert.equal(await ui.fetchAnnouncements(), true)
  assert.equal(ui.opens, 2)
  assert.equal(ui.state.announcement.id, 'newer')
  assert.equal(ui.state.announcementItems.length, 1)
})

test('版本提醒先显示时延后公告，包括拉取过程中出现提醒的情况', async () => {
  const ui = announcementRuntime()
  ui.payload.items = [{ id: 'new', title: '新公告', content: '正文' }]
  ui.warning(true)
  assert.equal(await ui.fetchAnnouncements(), false)
  assert.equal(ui.requests, 0)
  ui.warning(false)
  ui.duringFetch = () => ui.warning(true)
  assert.equal(await ui.fetchAnnouncements(), false)
  assert.equal(ui.opens, 0)
  ui.duringFetch = null
  ui.warning(false)
  assert.equal(await ui.fetchAnnouncements(), true)
})

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

test('多条未读公告在同一窗口分页浏览，确认一次全部标为已读', () => {
  assert.match(html, /id="announcement-pagination"/)
  assert.match(html, /id="announcement-prev"/)
  assert.match(html, /id="announcement-next"/)
  assert.match(html, /id="announcement-page"/)
  assert.match(app, /function openAnnouncementModal\(items, index = 0\)/)
  assert.match(app, /openAnnouncementModal\(items\)/)
  assert.match(app, /function showAnnouncementAt\(index\)/)
  assert.match(app, /markAnnouncementsSeen\(state\.announcementItems\)/)
  assert.match(app, /announcementIndex - 1/)
  assert.match(app, /announcementIndex \+ 1/)
  assert.match(styles, /\.announcement-pagination\s*\{/)
})

test('反馈仅在服务器确认成功后显示明确确认', () => {
  assert.match(html, /id="modal-feedback-success"/)
  assert.match(html, /id="feedback-success-confirm"/)
  assert.match(html, /data-i18n="feedback\.successBody"/)
  assert.match(app, /if \(res\.ok && json\.ok\) \{ closeFeedbackModal\(\); openFeedbackSuccess\(\) \}/)
  assert.match(app, /feedback-success-confirm'\)\.addEventListener\('click', closeFeedbackSuccess\)/)
  assert.match(app, /e\.target === \$\('modal-feedback-success'\)/)
})
