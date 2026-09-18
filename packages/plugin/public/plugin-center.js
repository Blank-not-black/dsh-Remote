/* Shared mobile/desktop plugin center. Credentials stay in the parent connection. */
'use strict';
window.DshPluginCenter = (() => {
  let dialog, connection, snapshot, timer, generation = 0, pending = false, tab = 'installed', offset = 0, searchSequence = 0, detailSequence = 0
  let renderedInstalled = '', renderedJobs = ''
  const labels = { install: '安装', update: '更新', remove: '卸载', enable: '启用', disable: '停用', queued: '等待执行', running: '执行中', complete: '已完成', failed: '失败' }
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
      Promise.resolve().then(action).catch(error => { if (current === generation) message(error.message) })
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
    el.append(node('h3', name), node('p', description))
    return el
  }
  function renderInstalled() {
    const list = dialog.querySelector('.pc-list'); list.replaceChildren()
    if (!snapshot.items.length) list.append(node('p', '暂无可管理插件'))
    for (const item of snapshot.items) {
      const el = card(item.name, item.description)
      el.append(node('p', (item.version || item.requested || '内置') + ' · ' + (item.enabled ? '配置启用' : '配置停用') + (snapshot.pendingRestart ? ' · 待重启' : '')))
      if (item.managed && snapshot.writable) {
        const actions = node('div', null, 'pc-actions')
        actions.append(button('查看更新', () => showDetails(item.name)))
        if (item.bundle) actions.append(button(item.enabled ? '停用' : '启用', () => mutate(item.enabled ? 'disable' : 'enable', item.name)))
        actions.append(button('卸载', () => mutate('remove', item.name)))
        for (const action of actions.children) action.disabled = pending || snapshot.busy
        el.append(actions)
      } else el.append(node('small', '内置、核心或只读插件'))
      list.append(el)
    }
    const runtime = node('details')
    runtime.append(node('summary', '当前进程实际加载状态 (' + snapshot.runtime.length + ')'))
    if (!snapshot.runtimeAvailable) runtime.append(node('p', '此 DSH 版本未提供加载状态'))
    for (const entry of snapshot.runtime) runtime.append(node('p', entry.name + ' · ' + entry.phase + (entry.enabled ? '' : ' · disabled')))
    list.append(runtime)
  }
  async function refresh() {
    snapshot = await api('/state')
    dialog.querySelector('.pc-profile').textContent = snapshot.profile ? '当前环境：' + snapshot.profile : '当前环境无法识别'
    dialog.querySelector('.pc-status').textContent = snapshot.reason || (snapshot.pendingRestart ? '插件配置已变更，重启 DSH 后生效。' : '安装到当前连接的 DSH 主机。')
    const installedKey = JSON.stringify([snapshot.items, snapshot.runtime, snapshot.pendingRestart, snapshot.busy, snapshot.writable, pending])
    if (tab === 'installed' && installedKey !== renderedInstalled) { renderInstalled(); renderedInstalled = installedKey }
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
    list.replaceChildren(node('p', '来源：npm · 安装前校验 DSH bundle。目录收录不代表安全或兼容性审核。'))
    if (!data.items.length) list.append(node('p', '没有找到插件；也可直接输入完整 npm 包名后查看详情。'))
    for (const item of data.items) {
      const el = card(item.name, item.description)
      el.append(node('small', item.version), button('查看详情', () => showDetails(item.name)))
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
    review.append(button('确认' + labels[action], () => executeMutation(body)), button('取消', () => area.replaceChildren()))
    area.replaceChildren(review); area.scrollIntoView({ block: 'nearest' })
  }
  async function executeMutation(body) {
    if (pending) return
    const current = generation
    pending = true
    try {
      message('正在提交…')
      await api('/operations', body)
      message('已受理，可在操作记录查看结果。')
      dialog.querySelector('.pc-detail').replaceChildren()
    } catch (error) {
      if (current !== generation) return
      message(error.message + '；请先查看操作记录，避免重复提交。')
      const retry = button('重试同一请求', () => executeMutation(body))
      dialog.querySelector('.pc-detail').replaceChildren(retry)
    } finally { if (current === generation) { pending = false; await refresh() } }
  }
  async function open(config) {
    if (!dialog) {
      dialog = node('dialog', null, 'pc-dialog')
      const heading = node('div', null, 'pc-heading'); heading.append(node('h2', '插件中心'), button('关闭', () => dialog.close()))
      const toolbar = node('div', null, 'pc-actions')
      toolbar.append(button('已安装', () => { tab = 'installed'; renderedInstalled = ''; dialog.querySelector('.pc-market-tools').hidden = true; return refresh() }), button('发现插件', () => { tab = 'market'; offset = 0; dialog.querySelector('.pc-market-tools').hidden = false; return search() }), button('刷新状态', refresh))
      const market = node('form', null, 'pc-market-tools'); market.hidden = true
      const input = node('input', null, 'pc-search'); input.placeholder = '搜索插件或输入完整 npm 包名'; input.maxLength = 80; input.setAttribute('aria-label', '搜索插件或 npm 包名')
      market.append(input, button('搜索', () => { offset = 0; return search() }), button('按包名查看', () => showDetails(input.value.trim())))
      market.addEventListener('submit', event => { event.preventDefault(); offset = 0; search().catch(error => message(error.message)) })
      const jobs = node('details'); jobs.append(node('summary', '操作记录'), node('div', null, 'pc-jobs'))
      const alert = node('p', null, 'pc-message'); alert.setAttribute('role', 'status')
      dialog.append(heading, node('p', null, 'pc-profile'), node('p', null, 'pc-status'), toolbar, market, alert, node('div', null, 'pc-detail'), node('div', null, 'pc-list'), jobs)
      dialog.addEventListener('close', () => { generation++; clearTimeout(timer) })
      document.body.append(dialog)
    }
    generation++; searchSequence++; detailSequence++; connection = config; tab = 'installed'; pending = false; snapshot = null
    const current = generation
    renderedInstalled = ''; renderedJobs = ''
    dialog.querySelector('.pc-market-tools').hidden = true
    dialog.querySelector('.pc-detail').replaceChildren(); dialog.querySelector('.pc-list').replaceChildren(); dialog.querySelector('.pc-jobs').replaceChildren()
    dialog.showModal(); message('正在读取插件状态…')
    try { await refresh(); message('') } catch (error) { if (current === generation) message(error.message) }
    if (current !== generation) return
    async function poll() {
      if (!dialog.open || current !== generation) return
      try { await refresh() } catch (error) { if (current === generation) message(error.message) }
      if (dialog.open && current === generation) timer = setTimeout(poll, 4000)
    }
    timer = setTimeout(poll, 4000)
  }
  return { open }
})()
