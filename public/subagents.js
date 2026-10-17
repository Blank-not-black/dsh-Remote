/* Shared, dependency-free subagent browser. Only explicit disclosure reads a new level. */
(function (root) {
  'use strict'
  let view = null, page = null, pageBody = null, pageTitle = null
  const memories = new Map()
  const text = (cn, en) => String(root.I18N?.lang || 'zh').startsWith('en') ? en : cn
  function node(tag, label, cls) {
    const el = document.createElement(tag)
    if (label !== undefined) el.textContent = label
    if (cls) el.className = cls
    return el
  }
  function button(label, action, cls, key) {
    const el = node('button', label, cls)
    el.type = 'button'
    if (key) el.dataset.subFocus = key
    el.addEventListener('click', action)
    return el
  }
  const valid = v => view === v && !v.paused && v.options.valid()
  const modeLabel = mode => mode === 'one-shot' ? text('单次任务', 'One-shot task') : mode === 'continuable' ? text('可续接任务', 'Continuable task') : text('模式未知', 'Unknown mode')
  const activityLabel = activity => activity === 'running' ? text('运行中', 'Running') : activity === 'waiting' ? text('等待中', 'Waiting') : activity === 'inactive' ? text('未运行', 'Inactive') : text('状态未知', 'Unknown status')
  function reasonLabel(reason) {
    if (reason === 'migration-required') return text('请先在 DSH 中打开原会话完成迁移，再刷新目录', 'Open the source session in DSH to complete migration, then refresh the catalog')
    if (reason === 'external') return text('这是外部代理任务，请在 DSH 中查看', 'This is an external-agent task. View it in DSH')
    return ({ unsupported: text('当前版本无法识别此任务类型', 'This task type is not supported by the current version'), unavailable: text('记录暂时无法读取，可刷新重试', 'Record unavailable. Refresh to try again'), corrupt: text('任务信息不一致，暂不能打开', 'Task information is inconsistent. This record cannot be opened'), cycle: text('目录关系重复或形成循环', 'The catalog contains a repeated or circular relationship') })[reason] || text('此目录项暂时不可用', 'This catalog entry is unavailable')
  }
  function status(entry, diagnostic) {
    const value = diagnostic ? 'diagnostic' : ['running', 'waiting', 'inactive'].includes(entry.activity) ? entry.activity : 'unknown'
    const el = node('span', diagnostic ? text('目录异常', 'Catalog issue') : activityLabel(value), 'subtree-badge')
    el.dataset.activity = value
    return el
  }
  function model(v) {
    const rootItem = { key: 'root', id: v.id, label: v.options.title || v.id, parent: null, depth: 0, entry: { activity: v.options.activity }, children: [] }
    const byKey = new Map([['root', rootItem]])
    let count = 0, running = 0, issues = 0, limited = false
    function visit(parent, ancestors) {
      const cached = v.cache.get(parent.id)
      for (const entry of cached?.value?.entries || []) {
        if (byKey.size > 300) { limited = true; break }
        const diagnostic = entry.kind === 'diagnostic' || !entry.id || ancestors.has(entry.id)
        const item = { key: parent.key + '/' + (entry.id ? encodeURIComponent(entry.id) : 'unknown-' + parent.children.length), id: entry.id || '', label: entry.label || entry.id?.slice(0, 12) || text('异常条目', 'Catalog issue'), entry, parent, depth: parent.depth + 1, diagnostic, reason: ancestors.has(entry.id) ? 'cycle' : entry.reason, children: [] }
        byKey.set(item.key, item); parent.children.push(item)
        if (diagnostic) issues++
        else {
          count++; if (entry.activity === 'running') running++
          if (item.depth < 16) visit(item, new Set([...ancestors, item.id]))
          else if (entry.hasChildren !== false) limited = true
        }
      }
    }
    visit(rootItem, new Set([v.id]))
    return { rootItem, byKey, count, running, issues, limited }
  }
  async function read(v, id, force = false) {
    if (!valid(v)) return
    const previous = v.cache.get(id)
    if (previous?.loading || (!force && (previous?.value || previous?.error))) return
    const item = { ...previous, loading: true, error: '' }
    v.cache.set(id, item); paint(v)
    try {
      const value = await v.options.read(id)
      if (!valid(v)) { v.cache.delete(id); return }
      if (!Array.isArray(value?.entries)) throw new Error(text('未能读取子代理目录', 'Subagent catalog unavailable'))
      item.value = value; item.updatedAt = Date.now()
      const ancestors = new Set([v.id, id])
      let parent = [...model(v).byKey.values()].find(item => !item.diagnostic && item.id === id)
      for (; parent; parent = parent.parent) ancestors.add(parent.id)
      for (const entry of value.entries) if (entry.kind !== 'diagnostic' && entry.id && !ancestors.has(entry.id)) v.options.remember(entry, id)
    } catch (error) {
      if (!valid(v)) { v.cache.delete(id); return }
      item.error = String(error.message || error)
    } finally { item.loading = false; if (valid(v)) paint(v) }
  }
  async function refresh(v) {
    if (!valid(v) || v.refreshing) return
    v.refreshing = true; paint(v)
    const seen = new Set()
    async function visit(id, depth) {
      if (!valid(v) || seen.has(id) || seen.size >= 300 || depth > 16) return
      seen.add(id); await read(v, id, true)
      if (!valid(v) || !v.expanded.has(id)) return
      for (const entry of v.cache.get(id)?.value?.entries || []) {
        if (entry.kind !== 'diagnostic' && entry.id && v.expanded.has(entry.id)) await visit(entry.id, depth + 1)
      }
    }
    try { await visit(v.id, 0) } finally { v.refreshing = false; if (valid(v)) paint(v) }
  }
  function shell(v) {
    const el = v.el = node('section', undefined, 'subtree')
    const toolbar = node('div', undefined, 'subtree-toolbar')
    const search = v.search = node('input', undefined, 'subtree-search')
    search.type = 'search'; search.placeholder = text('查找已读取的名称或 ID', 'Find a loaded name or ID')
    search.setAttribute('aria-label', search.placeholder)
    search.addEventListener('input', () => { v.query = search.value; paint(v) })
    const filters = node('div', undefined, 'subtree-filters')
    filters.setAttribute('aria-label', text('按状态筛选', 'Filter by status'))
    v.filters = []
    for (const [key, label] of [['all', text('全部', 'All')], ['running', text('运行中', 'Running')], ['diagnostic', text('异常', 'Issues')]]) {
      const b = button(label, () => { v.filter = key; paint(v) }, '', 'filter:' + key)
      filters.append(b); v.filters.push([key, b])
    }
    toolbar.append(search, filters)
    const actions = node('div', undefined, 'subtree-toolbar-actions')
    const collapse = button(text('收起分支', 'Collapse branches'), () => { v.expanded.clear(); v.expanded.add(v.id); paint(v) }, 'subtree-quiet', 'collapse')
    v.collapseButton = collapse
    const refreshButton = v.refreshButton = button(text('刷新', 'Refresh'), () => void refresh(v), 'subtree-quiet', 'refresh')
    actions.append(collapse, refreshButton); toolbar.append(actions)
    v.summary = node('div', undefined, 'subtree-summary'); v.summary.setAttribute('role', 'status')
    const layout = node('div', undefined, 'subtree-layout')
    v.tree = node('div', undefined, 'subtree-outline'); v.tree.setAttribute('aria-label', text('子代理层级', 'Subagent hierarchy'))
    v.detail = node('aside', undefined, 'subtree-detail'); v.detail.setAttribute('aria-label', text('所选节点详情', 'Selected node details'))
    layout.append(v.tree, v.detail); el.append(toolbar, v.summary, layout)
  }
  function select(v, item) {
    v.selected = item.key; paint(v)
    if (root.matchMedia?.('(max-width:800px)').matches) v.detail.scrollIntoView({ behavior: root.matchMedia('(prefers-reduced-motion:reduce)').matches ? 'auto' : 'smooth', block: 'start' })
    v.detailTitle?.focus({ preventScroll: true })
  }
  function details(v, item, outsideFilter) {
    const box = v.detail; box.replaceChildren()
    box.append(button(text('↑ 返回层级', '↑ Back to hierarchy'), () => {
      const card = v.cards.get(item.key) || v.cards.get('root')
      card?.scrollIntoView({ block: 'center' }); card?.focus({ preventScroll: true })
    }, 'subtree-parent subtree-back-to-tree', 'back-to-tree'))
    box.append(node('div', text('节点详情', 'Node details'), 'subtree-eyebrow'))
    const title = v.detailTitle = node('h3', item.label); title.tabIndex = -1; box.append(title)
    if (outsideFilter) box.append(node('p', text('此选中节点不在当前筛选结果中。', 'This selected node is outside the current filter.'), 'subtree-note'))
    const badges = node('div', undefined, 'subtree-detail-badges')
    if (item.key === 'root') badges.append(node('span', text('当前会话', 'Current session'), 'subtree-kind'))
    else badges.append(node('span', item.diagnostic ? text('不可打开', 'Unavailable') : modeLabel(item.entry.mode), 'subtree-kind'))
    badges.append(status(item.entry, item.diagnostic)); box.append(badges)
    const path = []; for (let p = item; p; p = p.parent) path.unshift(p.label)
    box.append(node('div', text('所在分支', 'Branch'), 'subtree-field-label'), node('p', path.join(' › '), 'subtree-path'))
    if (item.parent) {
      box.append(node('div', text('直接父会话', 'Direct parent'), 'subtree-field-label'))
      box.append(button(item.parent.label, () => select(v, item.parent), 'subtree-parent', 'parent:' + item.key))
    }
    box.append(node('div', text('会话 ID', 'Session ID'), 'subtree-field-label'), node('code', item.id || '—', 'subtree-id'))
    if (item.diagnostic) {
      box.append(node('p', reasonLabel(item.reason), 'subtree-notice'))
      if (item.reason) box.append(node('code', item.reason, 'subtree-reason'))
      box.append(button(text('刷新目录', 'Refresh catalog'), () => void read(v, item.parent.id, true), 'subtree-action', 'retry-detail')); return
    }
    const cached = v.cache.get(item.id)
    if (cached?.value) box.append(node('p', text(`已读取 ${item.children.filter(c => !c.diagnostic).length} 个直接子代理`, `${item.children.filter(c => !c.diagnostic).length} direct subagents loaded`), 'subtree-note'))
    else if (item.entry.hasChildren !== false && item.key !== 'root') box.append(node('p', text('展开节点前的箭头，读取下一层任务。', 'Expand the node arrow to load the next level.'), 'subtree-note'))
    const actions = node('div', undefined, 'subtree-detail-actions')
    actions.append(button(item.key === 'root' ? text('返回当前对话', 'Back to current chat') : text('打开只读记录 ↗', 'Open read-only record ↗'), () => {
      if (!valid(v)) return
      root.DshSubagents.close(); if (item.parent) void v.options.open(item.entry, item.parent.id)
    }, 'subtree-action subtree-primary', 'open:' + item.key))
    const parentCatalog = item.parent && v.cache.get(item.parent.id)?.value
    if (item.entry.mode === 'continuable' && item.entry.activity === 'running' && parentCatalog?.parentAvailable !== false) {
      actions.append(button(text('中断任务', 'Interrupt task'), () => { if (valid(v)) void v.options.interrupt(item.id, item.parent.id) }, 'subtree-action subtree-danger', 'interrupt:' + item.key))
    }
    box.append(actions, node('p', item.parent ? text('打开记录后，返回会进入它的直接父会话。', 'From a record, Back opens its direct parent session.') : text('选择树中的子代理，查看任务详情。', 'Select a subagent in the tree to inspect its details.'), 'subtree-note'))
  }
  function paint(v) {
    if (!valid(v)) return
    const focused = document.activeElement?.dataset?.subFocus
    const m = model(v), query = v.query.trim().toLocaleLowerCase(), filtering = !!query || v.filter !== 'all'
    const matches = new Set()
    function match(item) {
      const own = (!query || `${item.label} ${item.id}`.toLocaleLowerCase().includes(query)) && (v.filter === 'all' || (v.filter === 'diagnostic' ? item.diagnostic : !item.diagnostic && item.entry.activity === 'running'))
      const descendant = item.children.map(match).some(Boolean)
      if (own || descendant) matches.add(item.key)
      return own || descendant
    }
    m.rootItem.children.forEach(match)
    v.refreshButton.disabled = !!v.refreshing; v.refreshButton.textContent = v.refreshing ? text('刷新中…', 'Refreshing…') : text('刷新', 'Refresh')
    v.collapseButton.disabled = filtering
    v.collapseButton.title = filtering ? text('清除筛选后可收起分支', 'Clear filters to collapse branches') : ''
    for (const [key, b] of v.filters) b.setAttribute('aria-pressed', String(key === v.filter))
    const labels = [text(`已读取 ${m.count} 个子代理`, `${m.count} subagents loaded`), text(`${m.running} 个运行中`, `${m.running} running`), text(`${m.issues} 个目录异常`, `${m.issues} catalog issues`)]
    if (v.summarySignature !== labels.join('|')) {
      v.summarySignature = labels.join('|'); v.summary.replaceChildren()
      for (const label of labels) v.summary.append(node('span', label))
    }
    v.tree.replaceChildren()
    v.cards = new Map()
    function feedback(parent, list) {
      const cached = v.cache.get(parent.id)
      if (cached?.error) {
        const warning = node('li', undefined, 'subtree-feedback subtree-warning')
        warning.append(node('strong', cached.value ? text('刷新失败，保留上次目录', 'Refresh failed. Showing the last catalog') : text('暂时无法读取目录', 'Catalog unavailable')), node('p', cached.error))
        warning.append(button(text('重试', 'Retry'), () => void read(v, parent.id, true), 'subtree-action', 'retry:' + parent.key)); list.append(warning)
      }
      if (cached?.loading) list.append(node('li', text('正在读取这一层…', 'Loading this level…'), 'subtree-feedback'))
      if (cached?.value && !cached.value.entries.length && !cached.error) {
        const empty = node('li', undefined, 'subtree-feedback')
        empty.append(node('strong', text('暂无子代理', 'No subagents')), node('p', text('此会话还没有子代理记录。产生新任务后可刷新查看。', 'This session has no subagent records yet. Refresh after new tasks are created.'))); list.append(empty)
      }
    }
    function row(item) {
      const li = node('li'), line = node('div', undefined, 'subtree-row')
      const cached = v.cache.get(item.id), expanded = v.expanded.has(item.id)
      const canExpand = !item.diagnostic && item.depth < 16 && (cached?.value ? cached.value.entries.length > 0 : item.key === 'root' || item.entry.hasChildren !== false)
      if (canExpand) {
        const toggle = button(expanded ? '⌄' : '›', () => {
          if (expanded) v.expanded.delete(item.id)
          else { v.expanded.add(item.id); void read(v, item.id) }
          paint(v)
        }, 'subtree-disclosure', 'toggle:' + item.key)
        toggle.setAttribute('aria-expanded', String(expanded)); toggle.setAttribute('aria-label', (expanded ? text('收起 ', 'Collapse ') : text('展开 ', 'Expand ')) + item.label); line.append(toggle)
      } else line.append(node('span', '·', 'subtree-leaf'))
      const card = button(undefined, () => select(v, item), 'subtree-node', 'select:' + item.key)
      v.cards.set(item.key, card)
      card.setAttribute('aria-pressed', String(item.key === v.selected)); card.title = item.id
      const head = node('span', undefined, 'subtree-node-head'); head.append(node('strong', item.label), status(item.entry, item.diagnostic))
      const meta = node('span', undefined, 'subtree-node-meta')
      meta.append(node('span', item.key === 'root' ? text('当前会话 · 树的起点', 'Current session · Tree root') : item.diagnostic ? reasonLabel(item.reason) : modeLabel(item.entry.mode)))
      if (item.depth >= 4) meta.append(node('span', text(`第 ${item.depth} 层`, `Level ${item.depth}`), 'subtree-depth'))
      if (!item.diagnostic && cached?.value && item.children.length) meta.append(node('span', text(`${item.children.length} 个下级条目`, `${item.children.length} child entries`)))
      card.append(head, meta); line.append(card); li.append(line)
      if (!item.diagnostic && (expanded || filtering)) {
        const list = node('ul', undefined, 'subtree-list')
        for (const child of item.children) if (!filtering || matches.has(child.key)) list.append(row(child))
        if (!filtering || cached?.loading || cached?.error) feedback(item, list)
        if (list.children.length) li.append(list)
      }
      return li
    }
    const treeList = node('ul', undefined, 'subtree-list subtree-root-list'); treeList.append(row(m.rootItem)); v.tree.append(treeList)
    if (filtering && v.cache.get(v.id)?.value && !v.cache.get(v.id)?.loading && !m.rootItem.children.some(c => matches.has(c.key))) {
      const empty = node('div', undefined, 'subtree-feedback')
      empty.append(node('strong', text('已读取目录中没有匹配项', 'No matches in the loaded catalog')), node('p', text('筛选仅检查已读取的节点，不会自动加载其他分支。', 'Filters only inspect loaded nodes and do not load other branches.')))
      empty.append(button(text('清除筛选', 'Clear filters'), () => { v.query = ''; v.search.value = ''; v.filter = 'all'; paint(v) }, 'subtree-action', 'clear')); v.tree.append(empty)
    }
    if (m.limited) v.tree.append(node('p', text('目录较大，打开子代理记录可继续查看更深层。', 'Open a child record to explore more of this large catalog.'), 'subtree-note'))
    const selected = m.byKey.get(v.selected) || m.rootItem
    v.selected = selected.key; details(v, selected, filtering && selected.key !== 'root' && !matches.has(selected.key))
    if (focused) for (const el of v.el.querySelectorAll('[data-sub-focus]')) if (el.dataset.subFocus === focused) el.focus({ preventScroll: true })
  }
  root.DshSubagents = {
    configure(entry, options) {
      if (!entry) return
      entry.onclick = () => { if (options.valid()) root.DshSubagents.show(options) }
      if (page?.open) { if (view?.id === options.sessionId) root.DshSubagents.mount(pageBody, options); else root.DshSubagents.close() }
    },
    show(options) {
      if (!options.valid()) return
      if (!page) {
        page = node('dialog', undefined, 'subagent-page'); page.id = 'subagent-page'; page.setAttribute('aria-labelledby', 'subagent-page-title')
        const head = node('header', undefined, 'subagent-page-head')
        const back = button(text('‹ 返回对话', '‹ Back to chat'), () => root.DshSubagents.close(), 'subagent-page-back')
        const titleBlock = node('div', undefined, 'subagent-page-heading'); titleBlock.append(node('span', text('会话 / 子代理', 'Conversation / Subagents'), 'subtree-eyebrow'))
        pageTitle = node('h2'); pageTitle.id = 'subagent-page-title'; titleBlock.append(pageTitle); head.append(back, titleBlock)
        pageBody = node('div', undefined, 'subagent-page-content'); page.append(head, pageBody)
        page.addEventListener('close', () => { if (view?.options.valid()) view.options.onClose?.(); root.DshSubagents.pause() }); document.body.append(page)
      }
      pageTitle.textContent = options.title || options.sessionId
      if (!page.open) { page.showModal(); options.onShow?.() }
      if (!view || view.id !== options.sessionId || !view.options.valid()) {
        const expanded = memories.get(options.sessionId) || new Set(); expanded.add(options.sessionId); memories.set(options.sessionId, expanded)
      }
      pageBody.replaceChildren(); root.DshSubagents.mount(pageBody, options)
    },
    close() { if (page?.open) { page.close(); root.DshSubagents.pause() } },
    mount(target, options) {
      if (!target || !options.valid()) return
      if (!view || view.id !== options.sessionId || !view.options.valid()) {
        if (view) memories.set(view.id, view.expanded)
        if (memories.size > 20) memories.delete(memories.keys().next().value)
        view = { id: options.sessionId, options, expanded: memories.get(options.sessionId) || new Set([options.sessionId]), cache: new Map(), paused: false, query: '', filter: 'all', selected: 'root' }; shell(view)
      }
      view.options = options; view.paused = false; target.append(view.el); paint(view)
      const cached = view.cache.get(view.id)
      if (cached?.value && Date.now() - cached.updatedAt >= 10000) void refresh(view); else void read(view, view.id)
    },
    pause() { if (view) view.paused = true },
    reset() { root.DshSubagents.close(); view = null; memories.clear() },
  }
})(window)
