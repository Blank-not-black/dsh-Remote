'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8')
const source = (from, to) => app.slice(app.indexOf(from), app.indexOf(to, app.indexOf(from)))
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
function runtime() {
  const elements = new Map(), cache = new Map()
  const c = vm.createContext({
    window: {}, state: { localVersion: '0.8.0', announcementItems: [], announcementIndex: 0 }, URL, Date,
    esc, t: key => ({ 'announcement.expand': '展开', 'announcement.collapse': '收起' }[key] || key),
    cmpVersion: () => 0, fmtFullTime: () => 'date', ANNOUNCEMENT_HISTORY_KEY: 'fixture-history',
    LS: { get: (key, fallback) => cache.get(key) ?? fallback, set: (key, value) => cache.set(key, value) },
    $: id => { if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', classList: { add() {}, remove() {}, toggle() {} }, removeAttribute() {} }); return elements.get(id) },
    renderAnnouncementPoll: () => c.pollRenders++, renderAnnouncementPagination: () => c.pageRenders++,
    pollRenders: 0, pageRenders: 0, announcementVote: () => null
  })
  vm.runInContext([
    source('function announcementVersionMatch(', 'function renderAnnouncementPoll('),
    source('function readAnnouncementHistory(', 'function announcementBoardItems('),
    source('function renderAnnouncementHistory(', 'function openAnnouncementHistory('),
    source('function renderAnnouncementModal(', 'function openAnnouncementModal(')
  ].join('\n'), c, { timeout: 1000 })
  return { c, elements }
}
const notice = () => ({ id: 'fixture', title: '标题', content: '完整正文，旧客户端仍能阅读。', summary: '节日祝福\r\n更新摘要', sections: [{ title: '更新细节', content: '段落一\r\n段落二' }, { title: '云中转计划', content: '尚未上线', expanded: false }], actionUrl: 'https://example.com/release' })

test('legacy announcements retain complete escaped text with no disclosure markup', () => {
  const { c } = runtime(), item = { id: 'old', title: '旧公告', content: 'old\r\n<script>bad</script>\rEND' }
  const normalized = c.normalizeAnnouncement(item, 'https://example.com')
  assert.equal(normalized.sections, undefined)
  assert.equal(c.announcementBodyHtml(normalized), 'old<br>&lt;script&gt;bad&lt;/script&gt;<br>END')
})

test('structured announcements show summary with native closed sections and explicit optional expansion', () => {
  const { c } = runtime(), item = notice()
  item.sections[1].expanded = true
  const normalized = c.normalizeAnnouncement(item, 'https://example.com'), html = c.announcementBodyHtml(normalized)
  assert.equal(normalized.content, item.content, 'legacy fallback is never replaced by the summary')
  assert.equal(normalized.sections.length, 2)
  assert.ok(html.includes('节日祝福<br>更新摘要'))
  assert.equal((html.match(/<details class="announcement-section">/g) || []).length, 1)
  assert.equal((html.match(/<details class="announcement-section" open>/g) || []).length, 1)
  assert.ok(html.includes('段落一<br>段落二'))
  assert.ok(html.includes('展开') && html.includes('收起'))
  assert.ok(!html.includes(item.content), 'fallback content is not duplicated in the structured view')
})

test('summary, section labels and section bodies are plain text and cannot inject elements or handlers', () => {
  const { c } = runtime(), item = notice()
  item.summary = '<img src=x onerror="bad()">'
  item.sections = [{ title: '</summary><script>bad()</script>', content: '<details open onclick="bad()">& text</details>', expanded: 'true' }]
  const html = c.announcementBodyHtml(c.normalizeAnnouncement(item, 'https://example.com'))
  assert.ok(!/<(?:script|img)\b/.test(html))
  assert.ok(!/<details[^>]*\b(?:open|onclick)=?/.test(html))
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'))
  assert.ok(html.includes('&amp; text'))
})

test('malformed or over-budget sections fall back to the full text rather than silently dropping content', () => {
  const { c } = runtime()
  const invalid = [
    { summary: '' }, { summary: 'x'.repeat(2001) }, { sections: [] },
    { sections: Array.from({ length: 9 }, () => ({ title: 't', content: 'c' })) },
    { sections: [null] }, { sections: [{ title: '', content: 'c' }] },
    { sections: [{ title: 'x'.repeat(161), content: 'c' }] },
    { sections: [{ title: 't', content: {} }] }, { sections: [{ title: 't', content: '' }] },
    { sections: [{ title: 't', content: 'x'.repeat(10001) }] },
    { sections: Array.from({ length: 8 }, () => ({ title: 't', content: 'x'.repeat(2600) })) }
  ]
  for (const fields of invalid) {
    const item = { ...notice(), ...fields }, normalized = c.normalizeAnnouncement(item, 'https://example.com')
    assert.equal(normalized.sections, undefined)
    assert.equal(c.announcementBodyHtml(normalized), item.content)
  }
})

test('section rendering is shared by the active modal and persisted announcement history', () => {
  const { c, elements } = runtime(), item = c.normalizeAnnouncement(notice(), 'https://example.com')
  c.state.announcementItems = [item]
  c.renderAnnouncementModal()
  assert.equal(c.pollRenders, 1); assert.equal(c.pageRenders, 1)
  assert.equal(elements.get('announcement-title').textContent, item.title)
  assert.equal(elements.get('announcement-action').href, item.actionUrl)
  const body = elements.get('announcement-content').innerHTML
  c.storeAnnouncementHistory([item]); c.renderAnnouncementHistory()
  assert.ok(elements.get('announcement-history-list').innerHTML.includes(body))
  assert.equal(c.readAnnouncementHistory()[0].sections.length, 2)
  c.state.announcementItems = [{ id: 'next', title: '下一条', content: '普通正文' }]
  c.renderAnnouncementModal()
  assert.equal(elements.get('announcement-content').innerHTML, '普通正文')
})
