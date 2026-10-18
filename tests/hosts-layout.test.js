'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const root=path.join(__dirname,'..')
const read=file=>fs.readFileSync(path.join(root,file),'utf8')
const between=(source,start,end)=>{
  const from=source.indexOf(start),to=source.indexOf(end,from+1)
  assert.ok(from>=0,`missing ${start}`);assert.ok(to>from,`missing ${end}`)
  return source.slice(from,to)
}

test('host address rows use a four-column grid and a narrow layout that cannot squeeze the address',()=>{
  const css=read('public/styles.css')
  assert.match(css,/\.server-row \{\s*display: grid; grid-template-columns: minmax\(0, 1fr\) auto auto auto;/, 'row is a grid')
  assert.match(css,/\.server-note \{[^}]*min-width: 0[^}]*overflow-wrap: anywhere/)
  assert.match(css,/\.server-url \{[^}]*min-width: 0[^}]*overflow-wrap: anywhere/)
  assert.match(css,/\.server-edit, \.server-del \{\s*flex-shrink: 0; display: grid; place-items: center; width: 32px; height: 32px;/, 'icon buttons stay compact')
  assert.match(css,/\.server-badge \{[^}]*min-width: 52px; text-align: center/,'status column keeps a steady width')
  assert.match(css,/\.group-bar \{[^}]*flex-wrap: nowrap/,'group bar never wraps the add button onto its own line')
  const workflow=read('public/workflow.css')
  assert.ok(workflow.includes('@media (max-width:360px) {'),'narrow breakpoint exists')
  assert.ok(workflow.includes('.workflow-v8 .workflow-subpage .server-row { grid-template-columns:minmax(0,1fr) auto auto; grid-template-areas:"note badge badge" "url edit del"; gap:2px 6px; }'))
  assert.ok(workflow.includes(':is(.server-row,.ds-server-row)'),'shared row rules cover both shells')
  // 通用 44px 触摸规则不能把分组标题里的图标按钮撑到 44px，否则 320px 下名称只剩一字宽。
  assert.ok(workflow.includes(':is(.srv-group-head,.ds-srv-head) :is(.srv-group-speed,.srv-group-del,.ds-mini) { min-width:32px; min-height:32px; width:32px; height:32px;'))
  const narrow = between(workflow, '@media (max-width:480px) {', '@media (max-width:360px) {')
  assert.ok(!/group-bar[^}]*flex-wrap:wrap/.test(narrow),'480px block no longer wraps the group bar')
})

test('each address shows one status badge, including 当前 for an untested active host',()=>{
  const app=read('public/app.js')
  const row=between(app,'function renderServers()','async function addServer()')
  assert.ok(!row.includes('server-token-badge'),'token state folded into the single status badge')
  assert.ok(row.includes('if (!s.token) badge = `<span class="server-badge bad">${t(\'servers.tokenMissing\')}</span>`'))
  assert.ok(row.includes("else if (active) badge = `<span class=\"server-badge good\">${t('servers.currentOnly')}</span>`"))
  assert.ok(row.includes('class="server-note" title='),'clamped note keeps the full text in a tooltip')
  assert.ok(row.includes('aria-label="${t(\'servers.edit\')}"'))
  assert.ok(app.includes("$('group-select-btn')?.setAttribute('aria-label', t('groups.currentLabel', { group: state.activeGroup }))"))
})

test('both languages ship the new badge and group labels, and the summary drops the empty latency brackets',()=>{
  const html=read('public/index.html')
  for(const text of [
    "'servers.currentOnly': '当前'","'servers.currentOnly': 'Current'",
    "'groups.currentLabel': '当前组：{group}'","'groups.currentLabel': 'Current group: {group}'",
    "'servers.currentDescGroup': '当前：{group} · {url}'","'servers.currentDescGroup': 'Current: {group} · {url}'",
  ]) assert.ok(html.includes(text),text)
  const app=read('public/app.js')
  assert.ok(app.includes("t('servers.currentDescGroup', { group: curGroup, url: curNote }) + (Number.isFinite(curMs) ? ' · ' + curMs + 'ms' : '')"))
  assert.ok(!app.includes("ms: Number.isFinite(curMs) ? curMs + 'ms' : '—'"))
})

test('the desktop shell keeps the same compact rows, badge precedence and labels',()=>{
  const css=read('public/desktop/desktop.css')
  assert.ok(css.includes('.ds-server-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto;'))
  assert.ok(css.includes('.ds-group-select { flex: 0 1 340px; min-width: 180px;'),'group selector no longer stretches across the card')
  assert.ok(css.includes('.ds-server-note { display: -webkit-box;'))
  const js=read('public/desktop/desktop.js')
  const row=between(js,'function renderServers()','async function addServer()')
  assert.ok(!row.includes('ds-server-token-badge'))
  assert.ok(row.includes("if (!s.token) badge = `<span class=\"ds-server-badge bad\">${t('ds.serversTokenMissing')}</span>`"))
  assert.ok(row.includes("t('ds.serversCurrentOnly')"))
  assert.ok(js.includes("$('group-select-btn')?.setAttribute('aria-label', t('ds.groupsCurrentLabel', { group: state.activeGroup }))"))
  const html=read('public/desktop/desktop.html')
  assert.ok(html.includes("'ds.serversCurrentOnly': '当前'"))
  assert.ok(html.includes("'ds.serversCurrentOnly': 'Current'"))
  assert.ok(html.includes("'ds.groupsCurrentLabel': '当前组：{group}'"))
  assert.ok(html.includes("'ds.serversCurrentDesc': 'Current: {group} · {url}'"))
})
