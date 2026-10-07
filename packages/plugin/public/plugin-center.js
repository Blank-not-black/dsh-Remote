/* Shared mobile/desktop plugin center. Credentials stay in the parent connection. */
'use strict';
window.DshPluginCenter = (() => {
  let dialog, connection, snapshot, timer, generation = 0, pending = false, tab = 'installed', offset = 0, searchSequence = 0, detailSequence = 0
  let renderedInstalled = '', renderedJobs = '', filter = '', statusFilter = 'all', refreshSequence = 0
  const labels = { install: '安装', update: '更新', remove: '卸载', enable: '启用', disable: '停用', queued: '等待执行', running: '执行中', complete: '已完成', failed: '失败', interrupted: '已中断', active: '运行中', pending: '等待依赖', loading: '加载中', disposed: '未运行', unloading: '卸载中', inactive: '未运行' }
  function node(tag, text, className) {
    const el = document.createElement(tag)
    if (text != null) el.textContent = text
    if (className) el.className = className
    return el
  }
  function button(text, action) {
    const el = node('button', text)
    el.type = 'button'; el.addEventListener('click', () => {
      const current = generation
      Promise.resolve().then(() => { if (current === generation) return action() }).catch(error => { if (current === generation) message(error.message) })
    })
    return el
  }
  function message(text) { dialog.querySelector('.pc-message').textContent = text }
  async function api(path, body) {
    if (!connection.valid()) throw new Error('连接已切换，请关闭后重新打开插件中心')
    const current = generation
    const response = await fetch(connection.url('/remote/api/plugins' + path), {
      method: body ? 'POST' : 'GET', headers: { ...connection.headers, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
    })
    if (current !== generation || !dialog.open || !connection.valid()) throw new Error('连接已切换，请重新打开插件中心')
    let data
    try { data = await response.json() } catch { throw new Error('当前服务器不支持插件中心，请升级主机端 Remote 插件') }
    if (current !== generation || !dialog.open || !connection.valid()) throw new Error('连接已切换，请重新打开插件中心')
    if (!response.ok || data.ok === false) throw new Error(data.message || '请求失败：HTTP ' + response.status)
    return data
  }
  function card(name, description) {
    const el = node('article', null, 'pc-card')
    const header = node('div', null, 'pc-card-head')
    const icon = node('span', (name || 'P').replace(/^@/, '').slice(0, 1).toUpperCase(), 'pc-plugin-icon')
    icon.setAttribute('aria-hidden', 'true')
    header.append(icon, node('h3', name)); el.append(header)
    if (description) el.append(node('p', description, 'pc-description'))
    return el
  }
  function renderInstalled() {
    const list = dialog.querySelector('.pc-list'); list.replaceChildren()
    if (!snapshot) { list.append(node('p', '尚未读取插件状态，请点击刷新。')); return }
    const rows = snapshot.items.filter(item => tab === 'builtin' ? !item.managed : item.managed)
      .filter(item => [item.name, item.displayName, item.description].join(' ').toLowerCase().includes(filter.toLowerCase()))
      .filter(item => statusFilter === 'all' || (statusFilter === 'enabled' ? item.enabled : !item.enabled))
    if (!rows.length) list.append(node('p', filter || statusFilter !== 'all' ? '没有匹配的插件。' : tab === 'builtin' ? '暂无内置插件。' : '还没有安装其他插件，点击“添加插件”查看详情并安装。', 'pc-empty'))
    for (const item of rows) {
      const el = card(item.displayName || item.name, item.description)
      el.append(node('small', item.name, 'pc-package'))
      const meta = node('div', null, 'pc-meta')
      meta.append(node('span', item.version ? 'v' + item.version : item.requested || '内置', 'pc-version'))
      if (!item.bundle || !item.managed || !snapshot.writable) meta.append(node('span', item.enabled ? '配置启用' : '配置停用', 'pc-badge ' + (item.enabled ? 'is-active' : '')))
      const runtime = item.runtime || []
      if (runtime.some(entry => entry.phase === 'failed')) meta.append(node('span', '运行异常', 'pc-badge is-error'))
      else if (runtime.length) meta.append(node('span', `${runtime.filter(entry => entry.phase === 'active').length}/${runtime.length} 组件运行中`, 'pc-badge'))
      el.append(meta)
      const actions = node('div', null, 'pc-card-actions')
      const detail = button('查看详情', () => installedDetails(item)); detail.className = 'pc-detail-button'
      actions.append(detail)
      if (item.managed && snapshot.writable) {
        actions.append(button('查看更新', () => showDetails(item.name)))
        if (item.bundle) {
          const toggle = button(item.enabled ? '已启用' : '已停用', () => mutate(item.enabled ? 'disable' : 'enable', item.name))
          toggle.className = 'pc-toggle'; toggle.disabled = pending || snapshot.busy
          toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(item.enabled)); toggle.setAttribute('aria-label', '启用 ' + item.name)
          toggle.setAttribute('title', item.enabled ? '配置已启用' : '配置已停用')
          el.querySelector('.pc-card-head').append(toggle)
        }
        const remove = button('卸载', () => mutate('remove', item.name)); remove.className = 'pc-danger-button'; actions.append(remove)
        for (const action of actions.children) if (action !== detail) action.disabled = pending || snapshot.busy
      } else actions.append(node('small', '主机维护 · 只读'))
      el.append(actions)
      list.append(el)
    }
    const runtime = node('details', null, 'pc-runtime')
    runtime.append(node('summary', '当前进程实际加载状态 (' + snapshot.runtime.length + ')'))
    if (!snapshot.runtimeAvailable) runtime.append(node('p', '此 DSH 版本未提供加载状态'))
    for (const entry of snapshot.runtime) runtime.append(node('p', entry.name + ' · ' + entry.phase + (entry.enabled ? '' : ' · disabled')))
    list.append(runtime)
  }
  function installedDetails(item) {
    detailSequence++
    const area = dialog.querySelector('.pc-detail')
    const el = card(item.displayName || item.name, item.description)
    el.append(node('p', item.name + ' · ' + (item.version || item.requested || '内置')), node('p', '配置：' + (item.enabled ? '启用' : '停用')))
    const entries = item.runtime || []
    el.append(node('h4', '组件运行状态'))
    if (!entries.length) el.append(node('p', '未获得该包的组件归属。可在下方查看当前进程全部加载状态。'))
    for (const entry of entries) el.append(node('p', entry.name + ' · ' + (labels[entry.phase] || entry.phase)))
    if (!item.managed) el.append(node('p', '随 DSH 提供的核心插件由主机维护。'))
    el.append(button('返回插件列表', () => area.replaceChildren()))
    area.replaceChildren(el); area.scrollIntoView({ block: 'nearest' })
  }
  function renderTabs() {
    for (const button of dialog.querySelectorAll('[data-pc-tab]')) {
      button.classList.toggle('active', button.dataset.pcTab === tab)
      button.setAttribute('aria-pressed', String(button.dataset.pcTab === tab))
    }
  }
  async function refresh() {
    const sequence = ++refreshSequence
    let data
    try { data = await api('/state') } catch (error) { if (sequence === refreshSequence) throw error; return }
    if (sequence !== refreshSequence) return
    snapshot = data
    const recovery = dialog.querySelector('.pc-recovery'); recovery.replaceChildren()
    if (snapshot.recovery) {
      recovery.append(node('p', snapshot.recovery.reason))
      const action = button('恢复旧任务', () => {
        const body = { id: snapshot.recovery.id, revision: snapshot.revision, confirmNoRunningProcess: true }
        const review = card('解除旧任务锁', '请先在主机确认没有正在运行的插件安装或卸载进程。此操作保留文件和备份，不执行回滚。')
        review.append(button('已确认，解除锁定', () => executeMutation(body, '/recover')), button('取消', () => dialog.querySelector('.pc-detail').replaceChildren()))
        dialog.querySelector('.pc-detail').replaceChildren(review)
      })
      action.disabled = !snapshot.writable || pending; recovery.append(action)
    }
    dialog.querySelector('.pc-profile').textContent = snapshot.profile ? '当前环境：' + snapshot.profile : '当前环境无法识别'
    dialog.querySelector('.pc-status').textContent = snapshot.reason || (snapshot.pendingRestart ? '插件配置已变更，重启 DSH 后生效。' : '安装到当前连接的 DSH 主机。')
    dialog.querySelector('.pc-status').hidden = !snapshot.reason && !snapshot.pendingRestart
    const summary = dialog.querySelector('.pc-summary'); summary.replaceChildren()
    for (const [count, title] of [[snapshot.items.filter(item => item.managed).length, '已安装'], [snapshot.items.filter(item => item.managed && item.enabled).length, '配置启用']]) {
      const stat = node('span', null, 'pc-stat'); stat.append(node('strong', String(count)), node('span', title)); summary.append(stat)
    }
    if (snapshot.busy) summary.append(node('span', '任务执行中', 'pc-badge'))
    const installedKey = JSON.stringify([snapshot.items, snapshot.runtime, snapshot.pendingRestart, snapshot.busy, snapshot.writable, pending, tab, filter, statusFilter])
    if (tab !== 'market' && installedKey !== renderedInstalled) { renderInstalled(); renderedInstalled = installedKey }
    renderTabs()
    const jobsKey = JSON.stringify(snapshot.operations)
    if (jobsKey === renderedJobs) return
    renderedJobs = jobsKey
    const jobs = dialog.querySelector('.pc-jobs')
    const expanded = new Set([...jobs.querySelectorAll('details[open]')].map(el => el.dataset.id))
    jobs.replaceChildren()
    for (const job of snapshot.operations) {
      const el = node('details')
      el.dataset.id = job.id; el.open = expanded.has(job.id)
      el.append(node('summary', (labels[job.action] || job.action) + ' ' + job.name + (job.version ? '@' + job.version : '') + ' · ' + (labels[job.phase] || job.phase)))
      el.append(node('small', new Date(job.startedAt).toLocaleString()))
      el.append(node('p', job.message || '任务在主机端执行，可关闭窗口后回来查看。'))
      if (job.log) el.append(node('pre', job.log))
      jobs.append(el)
    }
  }
  async function search() {
    const sequence = ++searchSequence
    const q = dialog.querySelector('.pc-search').value.trim()
    const list = dialog.querySelector('.pc-list'); list.replaceChildren(node('p', '正在查询 npm 插件目录…'))
    const data = await api('/market?q=' + encodeURIComponent(q) + '&offset=' + offset)
    if (tab !== 'market' || sequence !== searchSequence) return
    list.replaceChildren(node('p', '来源：npm · 安装前校验 DSH bundle。目录收录不代表安全或兼容性审核。', 'pc-market-note'))
    if (!data.items.length) list.append(node('p', '没有找到插件；也可直接输入完整 npm 包名后查看详情。'))
    for (const item of data.items) {
      const el = card(item.name, item.description)
      const meta = node('div', null, 'pc-meta'); meta.append(node('span', item.version ? 'v' + item.version : '版本未声明', 'pc-version'))
      const actions = node('div', null, 'pc-card-actions')
      const detail = button('查看详情', () => showDetails(item.name)); detail.className = 'pc-detail-button'; actions.append(detail)
      el.append(meta, actions)
      list.append(el)
    }
    if (offset > 0) list.append(button('上一页', () => { offset -= 20; return search() }))
    if (offset + 20 < data.total) list.append(button('下一页', () => { offset += 20; return search() }))
  }
  async function showDetails(name, version) {
    const sequence = ++detailSequence
    const { item } = await api('/details?name=' + encodeURIComponent(name) + (version ? '&version=' + encodeURIComponent(version) : ''))
    if (sequence !== detailSequence) return
    const area = dialog.querySelector('.pc-detail'); area.replaceChildren()
    const el = card(item.name + ' @ ' + item.version, item.description)
    el.append(node('p', '许可证：' + (item.license || '未声明') + ' · ' + (item.bundle ? 'DSH bundle' : '未声明 DSH bundle')))
    el.append(node('p', '运行要求：' + JSON.stringify(item.engines) + '；依赖要求：' + JSON.stringify(item.peers)))
    el.append(node('p', '插件代码将在 DSH 主机运行。安装脚本默认禁用；需要额外配置的插件须在主机完成配置。'))
    if (/^https:\/\//.test(item.homepage)) {
      const link = node('a', '项目主页'); link.href = item.homepage; link.target = '_blank'; link.rel = 'noopener noreferrer'; el.append(link)
    }
    const input = node('input'); input.value = item.version; input.setAttribute('aria-label', '插件版本'); input.placeholder = '指定版本，如 1.2.3'
    el.append(input, button('查看此版本', () => showDetails(name, input.value.trim())))
    const installed = snapshot?.items.find(row => row.name === name)
    const action = installed ? 'update' : 'install'
    const install = button((labels[action]) + ' ' + item.version, () => mutate(action, name, item.version))
    install.disabled = !item.bundle || item.protected || !snapshot?.writable || snapshot.busy || pending || installed?.version === item.version
    el.append(install, button('关闭详情', () => area.replaceChildren()))
    area.append(el); area.scrollIntoView({ block: 'nearest' })
  }
  async function mutate(action, name, version) {
    if (pending) return
    // LAN HTTP is not a secure context; an idempotency key does not need WebCrypto.
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
    const body = { id, action, name, ...(version ? { version } : {}), revision: snapshot.revision }
    const area = dialog.querySelector('.pc-detail')
    const review = card('确认' + labels[action], name + (version ? '@' + version : ''))
    review.append(node('p', '目标环境：' + snapshot.profile + '。配置修改后需要重启 DSH；不会自动重启。'))
    const confirm = button('确认' + labels[action], () => executeMutation(body)); confirm.className = action === 'remove' ? 'pc-danger-confirm' : 'pc-primary'
    review.append(confirm, button('取消', () => area.replaceChildren()))
    area.replaceChildren(review); area.scrollIntoView({ block: 'nearest' })
  }
  async function executeMutation(body, endpoint = '/operations') {
    if (pending) return
    const current = generation
    pending = true
    try {
      message('正在提交…')
      await api(endpoint, body)
      message('已受理，可在操作记录查看结果。')
      dialog.querySelector('.pc-detail').replaceChildren()
    } catch (error) {
      if (current !== generation) return
      message(error.message + '；请先查看操作记录，避免重复提交。')
      const retry = button('重试同一请求', () => executeMutation(body, endpoint))
      dialog.querySelector('.pc-detail').replaceChildren(retry)
    } finally { if (current === generation) { pending = false; await refresh() } }
  }
  function close() {
    generation++; searchSequence++; detailSequence++; clearTimeout(timer)
    if (!dialog) return
    if (dialog.tagName === 'DIALOG') dialog.close()
    else { dialog.open = false; dialog.remove() }
    dialog = null
  }
  async function open(config, target) {
    close()
    if (!dialog) {
      dialog = node(target ? 'div' : 'dialog', null, 'pc-dialog' + (target ? ' pc-page' : ''))
      const heading = node('div', null, 'pc-heading')
      const title = node('div', null, 'pc-title'); title.append(node('h2', '插件管理'), node('p', '管理当前主机的插件与扩展', 'pc-intro')); heading.append(title)
      if (!target) heading.append(button('关闭', close))
      const controls = node('div', null, 'pc-controls')
      const toolbar = node('div', null, 'pc-tabs')
      for (const [value, title] of [['installed', '已安装'], ['market', '添加插件'], ['builtin', '内置插件']]) {
        const control = button(title, () => {
          tab = value; detailSequence++; renderedInstalled = ''; dialog.querySelector('.pc-detail').replaceChildren()
          renderTabs(); message('')
          dialog.querySelector('.pc-market-tools').hidden = value !== 'market'; dialog.querySelector('.pc-filters').hidden = value === 'market'
          if (value === 'market') { offset = 0; return search() }
          return refresh()
        })
        control.dataset.pcTab = value; toolbar.append(control)
      }
      const refreshButton = button('刷新', () => tab === 'market' ? search() : refresh()); refreshButton.className = 'pc-refresh'
      const toolbarRow = node('div', null, 'pc-toolbar'); toolbarRow.append(toolbar, refreshButton)
      const filters = node('div', null, 'pc-filters')
      const query = node('input'); query.placeholder = '筛选已安装插件'; query.setAttribute('aria-label', '筛选已安装插件')
      query.addEventListener('input', () => { filter = query.value.trim(); renderInstalled() })
      const select = node('select'); select.setAttribute('aria-label', '按配置状态筛选')
      for (const [value, title] of [['all', '全部状态'], ['enabled', '配置启用'], ['disabled', '配置停用']]) { const option = node('option', title); option.value = value; select.append(option) }
      select.addEventListener('change', () => { statusFilter = select.value; renderInstalled() })
      filters.append(query, select)
      const market = node('form', null, 'pc-market-tools'); market.hidden = true
      const input = node('input', null, 'pc-search'); input.placeholder = '搜索插件或输入完整 npm 包名'; input.maxLength = 80; input.setAttribute('aria-label', '搜索插件或 npm 包名')
      market.append(input, button('搜索', () => { offset = 0; return search() }), button('按包名查看', () => showDetails(input.value.trim())))
      market.addEventListener('submit', event => {
        event.preventDefault(); offset = 0
        const current = generation
        search().catch(error => { if (current === generation) message(error.message) })
      })
      const jobs = node('details', null, 'pc-history'); jobs.append(node('summary', '操作记录'), node('div', null, 'pc-jobs'))
      const alert = node('p', null, 'pc-message'); alert.setAttribute('role', 'status')
      const context = node('div', null, 'pc-context'); context.append(node('p', null, 'pc-profile'), node('div', null, 'pc-summary'))
      controls.append(toolbarRow, filters, market)
      dialog.append(heading, context, node('p', null, 'pc-status'), controls, alert, node('div', null, 'pc-recovery'), node('div', null, 'pc-detail'), node('div', null, 'pc-list'), jobs)
      const surface = dialog
      dialog.addEventListener('close', () => {
        if (dialog !== surface) return
        generation++; clearTimeout(timer); dialog = null; surface.remove()
      })
      ;(target || document.body).append(dialog)
    }
    generation++; searchSequence++; detailSequence++; connection = config; tab = 'installed'; pending = false; snapshot = null; filter = ''; statusFilter = 'all'
    const current = generation
    renderedInstalled = ''; renderedJobs = ''
    dialog.querySelector('.pc-market-tools').hidden = true
    dialog.querySelector('.pc-detail').replaceChildren(); dialog.querySelector('.pc-list').replaceChildren(); dialog.querySelector('.pc-jobs').replaceChildren()
    if (target) dialog.open = true
    else dialog.showModal()
    message('正在读取插件状态…')
    try { await refresh(); message('') } catch (error) { if (current === generation) message(error.message) }
    if (current !== generation) return
    async function poll() {
      if (current !== generation || !dialog?.open) return
      try { await refresh() } catch (error) { if (current === generation) message(error.message) }
      if (current === generation && dialog?.open) timer = setTimeout(poll, 4000)
    }
    timer = setTimeout(poll, 4000)
  }
  return { open, mount: (config, target) => open(config, target), close }
})()
