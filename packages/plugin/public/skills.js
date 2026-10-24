/* Shared read-only skill center. Skill text is displayed as text, never executed. */
'use strict';
window.DshSkillsCenter = (() => {
  let current
  const sourceNames = { 'project-dsh': '项目 · DSH', 'project-agents': '项目 · Agents', custom: '自定义目录', 'user-dsh': '用户 · DSH', 'user-agents': '用户 · Agents', runtime: '插件注册', bundled: '内置技能' }
  const errors = { 'not-installed': '当前主机暂未提供技能中心，请返回插件列表核对状态。', unsupported: '主机技能中心接口不兼容，请核对插件版本。', 'host-denied': '主机拒绝读取技能，请检查主机认证状态。', 'skill-changed': '技能已变化，请刷新列表后重新选择。', 'skills-unavailable': '暂时无法读取主机技能，请重试。' }
  function node(tag, text, cls) { const el = document.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; return el }
  function button(label, fn) { const el = node('button', label); el.type = 'button'; el.addEventListener('click', fn); return el }
  function close() { if (current) { current.controller.abort(); current = null } }
  function live(s) { return current === s && s.connection.valid() }
  function placeDetail(s) {
    const selected = s.cards.get(s.selected)
    if (s.dedicated) {
      s.detail.hidden = !s.detailOpen
      s.body.hidden = s.detailOpen
      for (const part of s.listParts) part.hidden = s.detailOpen
      return
    }
    s.detail.hidden = s.mobile.matches && !selected
    const parent = s.mobile.matches && selected ? selected.card : s.body
    if (s.detail.parentNode !== parent) parent.append(s.detail)
    for (const [id, { card, action }] of s.cards) {
      const open = id === s.selected
      card.className = 'sc-card' + (open ? ' is-selected' : '')
      action.textContent = open ? '收起技能' : '查看技能'
      action.setAttribute('aria-pressed', String(open))
      action.setAttribute('aria-expanded', String(open))
    }
  }
  function scrollParent(el) {
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent
    }
    return document.scrollingElement
  }
  async function api(s, route) {
    if (!live(s)) throw new Error('连接已切换，请重新打开技能中心。')
    const response = await fetch(s.connection.url('/remote/api/skills' + route), { headers: s.connection.headers,
      signal: AbortSignal.any([s.controller.signal, AbortSignal.timeout(25000)]) })
    if (!live(s)) throw new Error('连接已切换，请重新打开技能中心。')
    let data
    try { data = await response.json() } catch { throw Object.assign(new Error('主机 Remote 尚不支持技能中心，请更新主机插件。'), { code: 'unsupported' }) }
    if (!live(s)) throw new Error('连接已切换，请重新打开技能中心。')
    if (!response.ok || data.ok === false || data.available === false) {
      throw Object.assign(new Error(errors[data.code] || '请求失败，请检查连接后重试。'), { code: response.status === 401 || response.status === 403 ? 'host-denied' : data.code || (response.status === 404 ? 'not-installed' : 'read-failed') })
    }
    return data
  }
  function renderList(s) {
    const q = s.search.value.trim().toLowerCase(), source = s.sources.value, status = s.status.value
    const rows = s.items.filter(row => (!source || row.source === source) && (!status || (status === 'on' ? row.modelInvocable === true : row.modelInvocable === false)))
      .filter(row => [row.name, row.description, row.whenToUse, row.workspace].join(' ').toLowerCase().includes(q))
    if (s.sort) rows.sort((a,b) => (s.sort.value === 'source' ? a.source.localeCompare(b.source) : 0) || a.name.localeCompare(b.name))
    if (s.selected && !rows.some(row => row.id === s.selected)) {
      s.selected = ''; ++s.detailSequence
      s.detail.replaceChildren(node('h3', '技能详情'), node('p', '选择一个技能，查看适用场景和正文。'))
    }
    s.count.textContent = rows.length + ' / ' + s.items.length + ' 个技能'
    s.list.replaceChildren()
    s.cards.clear()
    if (!rows.length) s.list.append(node('p', s.items.length ? '没有匹配的技能，试试更改筛选条件。' : '主机没有提供可显示的技能。', 'sc-empty'))
    for (const row of rows) {
      const card = node('article', null, 'sc-card' + (s.selected === row.id ? ' is-selected' : ''))
      card.append(node('small', sourceNames[row.source] || row.source, 'sc-source'), node('h3', row.name), node('p', row.description || '未提供说明', 'sc-description'))
      const flags = node('div', null, 'sc-flags')
      flags.append(node('span', row.modelInvocable == null ? '模型调用状态未知' : row.modelInvocable ? '模型可调用' : '模型调用已停用', 'pc-badge sc-status' + (row.modelInvocable ? ' is-active' : '')))
      if (row.workspace) flags.append(node('span', row.workspace, 'pc-badge'))
      card.append(flags)
      const action = button('查看技能', () => select(s, row)); card.append(action)
      s.cards.set(row.id, { card, action })
      s.list.append(card)
    }
    placeDetail(s)
  }
  async function select(s, row) {
    if (!live(s)) return
    const action = s.cards.get(row.id)?.action
    const scroller = !s.dedicated && s.mobile.matches && action ? scrollParent(action) : null
    const top = scroller ? action.getBoundingClientRect().top : 0
    const collapse = !s.dedicated && s.selected === row.id
    if (s.dedicated) {
      if (!s.detailOpen) { s.returnScroller = scrollParent(s.shell); s.returnScroll = s.returnScroller?.scrollTop || 0 }
      s.detailOpen = true
    }
    s.selected = collapse ? '' : row.id; const sequence = ++s.detailSequence
    s.detail.replaceChildren(node('h3', collapse ? '技能详情' : row.name), node('p', collapse ? '选择一个技能，查看适用场景和正文。' : '正在读取技能…'))
    placeDetail(s)
    if (s.dedicated && s.returnScroller) s.returnScroller.scrollTop = 0
    if (s.dedicated) s.detail.prepend(button('← 返回技能列表', () => back(s)))
    if (scroller) scroller.scrollTop += action.getBoundingClientRect().top - top
    if (collapse) return
    try {
      const data = await api(s, '/read?id=' + encodeURIComponent(row.id))
      if (!live(s) || sequence !== s.detailSequence) return
      if (data.content != null && typeof data.content !== 'string') throw Object.assign(new Error(errors.unsupported), { code:'unsupported' })
      window.DshExtensions?.reportAvailability?.(s.connection, 'skills', { ok: true })
      const item = data.item || row
      s.detail.replaceChildren(node('small', sourceNames[item.source] || item.source, 'sc-source'), node('h3', item.name), node('p', item.description || '未提供说明'))
      if (item.whenToUse) s.detail.append(node('h4', '适用场景'), node('p', item.whenToUse))
      s.detail.append(node('p', '模型调用：' + (item.modelInvocable == null ? '未知' : item.modelInvocable ? '允许' : '已停用') + ' · 手动调用：' + (item.userInvocable == null ? '未知' : item.userInvocable ? '允许' : '已停用'), 'sc-meta'), node('h4', '技能正文'))
      s.detail.append(data.content == null ? node('p', '此技能未提供可读取的文件正文。') : node('pre', data.content || '正文为空。', 'sc-content'))
      if (data.truncated) s.detail.append(node('p', '正文较长，当前显示前 100,000 个字符。', 'sc-notice'))
      if (s.dedicated) {
        s.detail.prepend(button('← 返回技能列表', () => back(s)))
        if (data.content != null) readingTools(s, data.content)
        s.detail.querySelector('button')?.focus({ preventScroll: true })
      }
    } catch (error) {
      if (live(s) && sequence === s.detailSequence) {
        window.DshExtensions?.reportAvailability?.(s.connection, 'skills', { code: error.code || (error.name === 'TimeoutError' ? 'timeout' : 'read-failed') })
        s.detail.replaceChildren(node('h3', row.name), node('p', error.message), button('重试读取', () => { s.selected = ''; void select(s, row) }))
      }
      if (live(s) && s.dedicated && sequence === s.detailSequence) s.detail.prepend(button('← 返回技能列表', () => back(s)))
    }
  }
  function back(s = current) {
    if (!s || !live(s) || !s.detailOpen) return false
    ++s.detailSequence; s.detailOpen = false; placeDetail(s)
    if (s.returnScroller) s.returnScroller.scrollTop = s.returnScroll
    s.cards.get(s.selected)?.action.focus({ preventScroll: true })
    return true
  }
  function readingTools(s, content) {
    const tools = node('div', null, 'sc-reading-tools'), search = node('input'), mode = node('select'), feedback = node('p', '', 'sc-meta')
    search.placeholder = '搜索技能正文'; search.setAttribute('aria-label', '搜索技能正文')
    for (const [value,label] of [['text','纯文本'],['markdown','Markdown 阅读']]) { const option=node('option',label); option.value=value; mode.append(option) }
    mode.value = 'text'; mode.setAttribute('aria-label','正文显示方式')
    const body = s.detail.querySelector('.sc-content')
    const render = () => {
      const query = search.value.trim()
      if (!query && mode.value === 'markdown' && typeof window.mdToHtml === 'function') { body.className = 'sc-content sc-markdown'; body.innerHTML = window.mdToHtml(content); feedback.textContent=''; return }
      body.className = 'sc-content'; body.replaceChildren()
      let cursor=0,count=0,index; const lower=content.toLowerCase(),needle=query.toLowerCase()
      while (needle && count<500 && (index=lower.indexOf(needle,cursor))>=0) {
        body.append(document.createTextNode(content.slice(cursor,index)),node('mark',content.slice(index,index+query.length)));cursor=index+query.length;count++
      }
      body.append(document.createTextNode(content.slice(cursor))); feedback.textContent = query ? `找到 ${count}${count===500?'+' : ''} 处匹配 · 搜索时显示纯文本` : ''
    }
    search.addEventListener('input',render); mode.addEventListener('change',render)
    const copy = button('复制正文',async()=>{ try { if (typeof window.copyText === 'function') { if (!await window.copyText(content)) throw new Error() } else await navigator.clipboard.writeText(content);feedback.textContent='正文已复制' } catch {feedback.textContent='复制失败，请选择正文后复制。'} })
    tools.append(search,mode,copy); body.before(tools,feedback)
  }
  async function refresh() {
    const s = current
    if (!s || !live(s)) return
    const sequence = ++s.listSequence; ++s.detailSequence
    s.message.textContent = '正在读取主机技能…'; s.reload.disabled = true
    try {
      const data = await api(s, '/list')
      if (!live(s) || sequence !== s.listSequence) return
      if (data.schema !== 1 || !Array.isArray(data.items)) throw Object.assign(new Error(errors.unsupported), { code: 'unsupported' })
      window.DshExtensions?.reportAvailability?.(s.connection, 'skills', { ok: true })
      s.items = data.items; s.selected = ''
      const previous = s.sources.value
      s.sources.replaceChildren(node('option', '全部来源'))
      s.sources.children[0].value = ''
      for (const key of [...new Set(s.items.map(row => row.source))]) { const option = node('option', (sourceNames[key] || key) + ' · ' + s.items.filter(row=>row.source===key).length); option.value = key; s.sources.append(option) }
      s.sources.value = [...s.sources.children].some(option => option.value === previous) ? previous : ''
      s.message.textContent = (data.complete === false ? '主机技能扫描尚不完整。' : '') + (data.truncated ? '当前显示前 500 个技能。' : '')
      s.updated.textContent = '更新于 ' + new Date(data.generatedAt).toLocaleTimeString()
      s.detail.replaceChildren(node('h3', '技能详情'), node('p', '选择一个技能，查看适用场景和正文。'))
      renderList(s)
    } catch (error) {
      if (live(s) && sequence === s.listSequence) {
        window.DshExtensions?.reportAvailability?.(s.connection, 'skills', { code: error.code || (error.name === 'TimeoutError' ? 'timeout' : 'read-failed') })
        s.message.textContent = error.message; s.updated.textContent = s.items.length ? '保留上次读取结果' : ''; if (!s.items.length) s.list.replaceChildren()
      }
    } finally { if (live(s) && sequence === s.listSequence) s.reload.disabled = false }
  }
  async function mount(connection, target, options = {}) {
    close()
    const s = { connection, controller: new AbortController(), items: [], selected: '', cards: new Map(), listSequence: 0, detailSequence: 0,
      dedicated: options.dedicated === true, detailOpen: false, mobile: window.matchMedia?.('(max-width:620px)') || { matches: false } }
    current = s
    const shell = node('section', null, 'sc-shell'), heading = node('div', null, 'sc-heading')
    s.shell = shell; if (s.dedicated) shell.className += ' sc-page'
    heading.append(node('h3', '技能中心'), node('p', '浏览主机技能、适用场景与调用状态。', 'sc-intro'))
    const filters = node('div', null, 'sc-filters')
    s.search = node('input'); s.search.value = ''; s.search.placeholder = '搜索技能名称、说明或适用场景'; s.search.setAttribute('aria-label', '搜索技能')
    s.sources = node('select'); s.sources.setAttribute('aria-label', '技能来源')
    s.status = node('select'); s.status.setAttribute('aria-label', '模型调用状态')
    for (const [value, label] of [['', '全部调用状态'], ['on', '模型可调用'], ['off', '模型调用已停用']]) { const option = node('option', label); option.value = value; s.status.append(option) }
    s.status.value = ''; s.sources.value = ''
    for (const el of [s.search, s.sources, s.status]) el.addEventListener(el === s.search ? 'input' : 'change', () => { if (live(s)) renderList(s) })
    s.reload = button('刷新技能', refresh); filters.append(s.search, s.sources, s.status)
    if (s.dedicated) { s.sort=node('select');s.sort.setAttribute('aria-label','技能排序');for(const [value,label] of [['name','按名称'],['source','按来源']]){const option=node('option',label);option.value=value;s.sort.append(option)}s.sort.value='name';s.sort.addEventListener('change',()=>{if(live(s))renderList(s)});filters.append(s.sort) }
    filters.append(s.reload)
    s.message = node('p', '', 'sc-notice'); s.message.setAttribute('role', 'status')
    s.count = node('strong', '', 'sc-count'); s.updated = node('small', '', 'sc-updated')
    const summary = node('div', null, 'sc-summary'); summary.append(s.count, s.updated)
    s.list = node('div', null, 'sc-list'); s.detail = node('section', null, 'sc-detail'); s.detail.setAttribute('aria-label', '技能详情')
    const body = node('div', null, 'sc-body'); s.body = body; body.append(s.list); if(!s.dedicated) body.append(s.detail)
    s.listParts = [heading, filters, s.message, summary]
    const resize = () => { if (live(s)) placeDetail(s) }
    s.mobile.addEventListener?.('change', resize)
    s.controller.signal.addEventListener('abort', () => s.mobile.removeEventListener?.('change', resize), { once: true })
    shell.append(heading, filters, s.message, summary, body); target.replaceChildren(shell)
    if(s.dedicated)shell.append(s.detail)
    await refresh()
  }
  return { mount, close, refresh, back }
})()
