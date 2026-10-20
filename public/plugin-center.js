/* Shared mobile/desktop plugin center. Credentials stay in the parent connection. */
'use strict';
window.DshPluginCenter = (() => {
  let dialog, connection, snapshot, timer, generation = 0, pending = false, tab = 'installed', offset = 0, searchSequence = 0, detailSequence = 0
  const expandedDetails = new Map()
  const marketCompatibility = new Map()
  let renderedInstalled = '', renderedJobs = '', filter = '', statusFilter = 'all', refreshSequence = 0, trackedOperation = ''
  const labels = { install: '安装', update: '更新', remove: '卸载', restore: '恢复', enable: '启用', disable: '停用', queued: '等待执行', running: '执行中', complete: '已完成', failed: '失败', interrupted: '已中断', active: '运行中', pending: '等待依赖', loading: '加载中', disposed: '未运行', unloading: '卸载中', inactive: '未运行' }
  const stages = { queued: '等待主机启动', backup: '备份配置', snapshot: '备份插件文件', restore: '恢复并校验', 'profile-lock': '检查配置锁', cli: '执行插件命令', verify: '保存并核验', complete: '完成' }
  function jobProgress(job) {
    const active = ['queued', 'running'].includes(job.phase), now = Date.now()
    const elapsed = Math.max(0, Math.floor(((active ? now : job.endedAt || now) - job.startedAt) / 1000))
    const parts = [stages[job.stage] || labels[job.phase] || job.phase, '耗时 ' + elapsed + ' 秒']
    if (active && job.updatedAt && now - job.updatedAt > 15000) parts.push('主机任务状态超过 15 秒未更新，正在重新核对进程')
    if (active && job.stage === 'cli') {
      const silence = Math.max(0, Math.floor((now - (job.lastOutputAt || job.startedAt)) / 1000))
      parts.push(job.lastOutputAt ? '最近输出在 ' + silence + ' 秒前' : '等待首次输出')
      if (silence >= 30) parts.push('暂无新输出，命令仍待结束；请展开日志检查网络或锁占用')
    }
    return parts.join(' · ')
  }
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
    if (!response.ok || data.ok === false) throw Object.assign(new Error(data.message || '请求失败：HTTP ' + response.status), { status: response.status })
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
    const list = dialog.querySelector('.pc-list'), restore = preserveListPosition(list); list.replaceChildren()
    if (!snapshot) { list.append(node('p', '尚未读取插件状态，请点击刷新。')); return }
    const rows = snapshot.items.filter(item => tab === 'builtin' ? !item.managed && item.name !== 'dsh-remote-plugin' : item.managed || item.name === 'dsh-remote-plugin')
      .filter(item => [item.name, item.displayName, item.description].join(' ').toLowerCase().includes(filter.toLowerCase()))
      .filter(item => statusFilter === 'all' || (statusFilter === 'enabled' ? item.enabled : !item.enabled))
    if (!rows.length) list.append(node('p', filter || statusFilter !== 'all' ? '没有匹配的插件。' : tab === 'builtin' ? '暂无内置插件。' : '当前主机没有其他已安装插件。第三方插件可按需选择。', 'pc-empty'))
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
      const area = inlineArea(item.name)
      const detail = button('查看详情', () => installedDetails(item, area, detail)); detail.className = 'pc-detail-button'
      actions.append(detail)
      if (item.managed && snapshot.writable) {
        actions.append(button('查看更新', () => showDetails(item.name, '', area, detail, true)))
        if (item.bundle) {
          const toggle = button(item.enabled ? '已启用' : '已停用', () => mutate(item.enabled ? 'disable' : 'enable', item.name))
          toggle.className = 'pc-toggle'; toggle.disabled = pending || snapshot.busy
          toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(item.enabled)); toggle.setAttribute('aria-label', '启用 ' + item.name)
          toggle.setAttribute('title', item.enabled ? '配置已启用' : '配置已停用')
          el.querySelector('.pc-card-head').append(toggle)
        }
        const remove = button('卸载', () => mutate('remove', item.name)); remove.className = 'pc-danger-button'; actions.append(remove)
        for (const action of actions.children) if (action !== detail) action.disabled = pending || snapshot.busy
      } else if (item.selfUpdate && snapshot.writable) {
        const update = button('更新 Remote', () => showDetails(item.name, '', area, detail, true))
        update.disabled = snapshot.busy || pending; actions.append(update)
      } else actions.append(node('small', '主机维护 · 只读'))
      if (connection.onFeature) {
        for (const feature of window.DshExtensions?.featuresFor(snapshot, item, !!connection.getSession?.()?.sessionId) || []) {
          const action = button(feature.label, () => connection.onFeature(feature.id))
          action.className = 'pc-open-feature'; actions.prepend(action)
        }
      }
      el.dataset.plugin = item.name
      detail.setAttribute('aria-controls', area.id)
      renderInline(area, detail, item)
      el.append(actions, area)
      list.append(el)
    }
    const runtime = node('details', null, 'pc-runtime')
    runtime.append(node('summary', '当前进程实际加载状态 (' + snapshot.runtime.length + ')'))
    if (!snapshot.runtimeAvailable) runtime.append(node('p', '此 DSH 版本未提供加载状态'))
    for (const entry of snapshot.runtime) runtime.append(node('p', entry.name + ' · ' + entry.phase + (entry.enabled ? '' : ' · disabled')))
    list.append(runtime)
    restore()
  }
  function preserveListPosition(list) {
    const anchor = [...list.children].find(el => el.dataset.plugin && el.getBoundingClientRect?.().bottom > 0)
    if (!anchor?.getBoundingClientRect) return () => {}
    const top = anchor.getBoundingClientRect().top, name = anchor.dataset.plugin
    let parent = list.parentElement
    while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement
    return () => {
      const current = [...list.children].find(el => el.dataset.plugin === name)
      if (!current) return
      const delta = current.getBoundingClientRect().top - top
      if (parent) parent.scrollTop += delta
      else window.scrollBy(0, delta)
    }
  }
  function inlineArea(name) {
    const area = node('section', null, 'pc-inline-detail')
    area.dataset.key = tab + ':' + name
    area.id = 'pc-detail-' + encodeURIComponent(area.dataset.key)
    return area
  }
  function currentArea(key) { return [...dialog.querySelectorAll('.pc-inline-detail')].find(el => el.dataset.key === key) }
  function renderInline(area, control, installed) {
    const entry = expandedDetails.get(area.dataset.key)
    control.textContent = entry ? '收起详情' : '查看详情'
    control.setAttribute('aria-expanded', String(!!entry))
    area.replaceChildren(); area.hidden = !entry
    if (!entry) return
    if (entry.loading) { area.append(node('p', '正在加载详情…', 'pc-detail-loading')); return }
    if (entry.error) { area.append(node('p', entry.error, 'pc-detail-error'), button('重试', () => showDetails(entry.name, entry.version, area, control, true))); return }
    if (entry.kind === 'installed') {
      const item = installed || entry.item
      if (item.description) area.append(node('p', item.description))
      area.append(node('p', '配置：' + (item.enabled ? '启用' : '停用')), node('h4', '组件运行状态'))
      const entries = item.runtime || []
      if (!entries.length) area.append(node('p', '未获得该包的组件归属。可在列表底部查看当前进程全部加载状态。'))
      for (const component of entries) area.append(node('p', component.name + ' · ' + (labels[component.phase] || component.phase)))
      if (!item.managed) area.append(node('p', '随 DSH 提供的核心插件由主机维护。'))
      readmeControl(area, item)
      return
    }
    const item = entry.item
    area.append(node('h4', item.name + ' @ ' + item.version), node('p', item.description || ''), node('p', '许可证：' + (item.license || '未声明') + ' · ' + (item.bundle ? 'DSH bundle' : '未声明 DSH bundle')))
    area.append(node('p', '运行要求：' + JSON.stringify(item.engines) + '；依赖要求：' + JSON.stringify(item.peers)))
    area.append(node('p', '插件代码将在 DSH 主机运行。安装脚本默认禁用；需要额外配置的插件须在主机完成配置。'))
    if (/^https:\/\//.test(item.homepage)) {
      const link = node('a', '项目主页'); link.href = item.homepage; link.target = '_blank'; link.rel = 'noopener noreferrer'; area.append(link)
    }
    const input = node('input'); input.value = entry.versionDraft ?? item.version; input.setAttribute('aria-label', '插件版本'); input.placeholder = '指定版本，如 1.2.3'
    input.addEventListener('input', () => { entry.versionDraft = input.value })
    area.append(input, button('查看此版本', () => showDetails(entry.name, input.value.trim(), area, control, true)))
    const row = snapshot?.items.find(row => row.name === item.name), action = row ? 'update' : 'install'
    const install = button(labels[action] + ' ' + item.version, () => mutate(action, item.name, item.version))
    install.disabled = !item.bundle || item.protected && !(row?.selfUpdate && action === 'update') || !snapshot?.writable || snapshot.busy || pending || row?.version === item.version || marketCompatibility.get(item.name + '@' + item.version) === false
    area.append(install)
    readmeControl(area, item)
  }
  function installedDetails(item, area, control) {
    if (expandedDetails.has(area.dataset.key)) expandedDetails.delete(area.dataset.key)
    else expandedDetails.set(area.dataset.key, { kind: 'installed', item })
    renderInline(area, control, item)
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
    window.DshExtensions?.remember(connection, snapshot)
    const tracked = snapshot.operations.find(job => job.id === trackedOperation)
    if (tracked && !['queued', 'running'].includes(tracked.phase)) {
      message((labels[tracked.phase] || tracked.phase) + '：' + tracked.name + '。' + (tracked.message || '请查看操作记录。'))
      trackedOperation = ''
    }
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
    for (const [count, title] of [[snapshot.items.filter(item => item.managed || item.name === 'dsh-remote-plugin').length, '已安装'], [snapshot.items.filter(item => (item.managed || item.name === 'dsh-remote-plugin') && item.enabled).length, '配置启用']]) {
      const stat = node('span', null, 'pc-stat'); stat.append(node('strong', String(count)), node('span', title)); summary.append(stat)
    }
    if (snapshot.busy) summary.append(node('span', '任务执行中', 'pc-badge'))
    const progress = dialog.querySelector('.pc-progress'); progress.replaceChildren()
    const activeJob = snapshot.operations.find(job => ['queued', 'running'].includes(job.phase))
    if (activeJob) progress.append(node('strong', (labels[activeJob.action] || activeJob.action) + ' ' + activeJob.name), node('p', jobProgress(activeJob)), node('p', activeJob.message || '任务在主机执行，可关闭窗口后回来查看。'))
    if (snapshot.busyReason) progress.append(node('p', snapshot.busyReason))
    if (snapshot.profileLock) progress.append(node('p', snapshot.profileLock.message))
    progress.hidden = !progress.children.length
    const installedKey = JSON.stringify([snapshot.items, snapshot.runtime, snapshot.runtimeAvailable, snapshot.pendingRestart, snapshot.busy, snapshot.writable, pending, tab, filter, statusFilter])
    if (['installed', 'builtin'].includes(tab) && installedKey !== renderedInstalled) { renderInstalled(); renderedInstalled = installedKey }
    renderTabs()
    const jobsKey = JSON.stringify(snapshot.operations.map(job => [job, jobProgress(job)]))
    if (jobsKey === renderedJobs) return
    renderedJobs = jobsKey
    const jobs = dialog.querySelector('.pc-jobs')
    const knownJobs = new Set([...jobs.children].map(el => el.dataset.id))
    if (activeJob && !knownJobs.has(activeJob.id)) dialog.querySelector('.pc-history').open = true
    const expanded = new Set([...jobs.querySelectorAll('details[open]')].map(el => el.dataset.id))
    jobs.replaceChildren()
    for (const job of snapshot.operations) {
      const el = node('details')
      el.dataset.id = job.id; el.open = expanded.has(job.id) || !knownJobs.has(job.id) && ['queued', 'running'].includes(job.phase)
      el.append(node('summary', (labels[job.action] || job.action) + ' ' + job.name + (job.version ? '@' + job.version : '') + ' · ' + (labels[job.phase] || job.phase)))
      el.append(node('small', new Date(job.startedAt).toLocaleString()))
      el.append(node('p', jobProgress(job), 'pc-job-progress'))
      el.append(node('p', job.message || '任务在主机端执行，可关闭窗口后回来查看。'))
      if (job.log) el.append(node('pre', job.log))
      if (job.canRestore) {
        const restore = button('恢复更新前状态', () => reviewRestore(job))
        restore.disabled = !snapshot.writable || snapshot.busy || pending
        el.append(restore)
      }
      jobs.append(el)
    }
  }
  const localText = value => typeof value === 'string' ? value : value?.['zh-CN'] || value?.zh || value?.en || Object.values(value || {})[0] || ''
  let marketIndex = '', marketCategory = '', marketSort = '', fetchedAt = null
  const README_IMAGE_HOSTS = ['raw.githubusercontent.com','github.com','objects.githubusercontent.com','user-images.githubusercontent.com','img.shields.io','shields.io','badgen.net','cdn.jsdelivr.net']
  function readmeControl(area, item) {
    const content = node('section', null, 'pc-readme')
    const action = button('阅读 README', async () => {
      const current = generation
      content.replaceChildren(node('p', '正在读取 README…'))
      try {
        const data = await api('/readme?name=' + encodeURIComponent(item.name))
        if (current !== generation || currentArea(area.dataset.key) !== area) return
        content.replaceChildren()
        if (!data.available) { content.append(node('p', '该插件未提供 README')); return }
        content.append(node('p', 'npm 当前包级 README，未按指定版本归档。' + (data.version ? ' latest 标签：' + data.version + '。' : '') + (data.truncated ? '内容已截断。' : '')))
        const markdown = node('div', null, 'md')
        if (window.mdToHtml) markdown.innerHTML = window.mdToHtml(data.content, { richContent: false, fileLinks: false, imageHosts: README_IMAGE_HOSTS })
        else markdown.textContent = data.content
        content.append(markdown)
      } catch (_) { if (current === generation) content.replaceChildren(node('p', 'README 暂时无法读取，请重试。')) }
    })
    area.append(action, content)
  }
  function adaptedCards(list) {
    const section = node('section', null, 'pc-adapted')
    section.append(node('h3', 'Remote 已适配'), node('p', '仅核验列出的版本；其他版本尚未验证。插件按需选择，安装前仍需确认。'))
    const capabilities = window.DshExtensions?.capabilitiesOf(snapshot) || {}
    for (const feature of window.DshExtensions?.catalog || []) {
      const installed = snapshot?.items.find(item => item.name === feature.name), el = card(feature.name, feature.summary)
      el.append(node('p', '已核验：' + feature.verified + ' · ' + (!snapshot ? '主机安装状态未知' : !installed ? '未安装' : capabilities[feature.id] ? '可用' : '已安装，当前不可用')))
      const area = inlineArea(feature.name), detail = button('查看详情', () => showDetails(feature.name, feature.verified, area, detail))
      area.dataset.key += ':adapted'; area.id += '-adapted'
      detail.className = 'pc-detail-button'; el.append(detail, area); renderInline(area, detail)
      if (!installed) {
        const install = button('安装已核验版本 ' + feature.verified, () => mutate('install', feature.name, feature.verified))
        install.disabled = !snapshot?.writable || snapshot.busy || pending; el.append(install)
      } else if (!feature.session && capabilities[feature.id] && connection.onFeature) el.append(button(feature.label, () => connection.onFeature(feature.id)))
      section.append(el)
    }
    list.append(section)
  }
  function selection(title, values, value, changed) {
    const select = node('select'); select.setAttribute('aria-label', title)
    for (const row of values) { const option = node('option', row.label); option.value = row.value; option.disabled = !!row.disabled; select.append(option) }
    select.value = value
    const current = generation
    select.addEventListener('change', () => { if (current !== generation) return; changed(select.value); offset = 0; void search() })
    return select
  }
  async function search(forceRefresh = false) {
    const sequence = ++searchSequence, current = generation
    const q = dialog.querySelector('.pc-search').value.trim()
    if (!offset) fetchedAt = null
    const list = dialog.querySelector('.pc-list'); list.replaceChildren(); adaptedCards(list)
    const results = node('section', null, 'pc-market-results'); list.append(results)
    results.append(node('p', '正在读取主机官方索引…'))
    try {
      const state = await api('/market/indexes')
      if (tab !== 'market' || sequence !== searchSequence || current !== generation) return
      results.replaceChildren()
      if (!state.available) { results.append(node('p', '当前主机未启用官方发现服务。仍可按完整包名查看详情。', 'pc-market-note')); return }
      if (!state.indexes.length) { results.append(node('p', '未配置索引源，以上为 Remote 已适配插件。请在主机 → 插件 → 发现 → 索引源添加后搜索。', 'pc-market-note')); return }
      if (!state.indexes.some(row => row.url === marketIndex && !row.code)) marketIndex = state.indexes.find(row => !row.code)?.url || ''
      const sources = selection('索引源', state.indexes.map(row => ({ value: row.url, label: localText(row.title) || row.url || '索引不可用', disabled: !!row.code })), marketIndex, value => { marketIndex = value; marketCategory = '' })
      results.append(sources)
      if (!marketIndex) { results.append(node('p', '索引暂时不可用，请在主机检查索引源配置。', 'pc-market-note')); return }
      const params = new URLSearchParams({ q, offset: String(offset), index: marketIndex, sort: marketSort || (q ? 'relevance' : 'index') })
      if (marketCategory) params.set('category', marketCategory)
      if (fetchedAt !== null) params.set('fetchedAt', String(fetchedAt))
      if (forceRefresh) params.set('refresh', '1')
      const data = await api('/market?' + params)
      if (tab !== 'market' || sequence !== searchSequence || current !== generation) return
      if (!data.available) { results.append(node('p', '官方索引暂时无法读取，请重试。', 'pc-market-note')); return }
      fetchedAt = data.fetchedAt
      results.append(node('p', '来源：主机官方索引（' + (localText(data.index?.title) || marketIndex) + '）。索引为第三方声明，不代表安全审核。', 'pc-market-note'))
      const controls = node('div', null, 'pc-market-controls')
      controls.append(selection('分类', [{ value: '', label: '全部分类' }, ...(data.categories || []).map(row => ({ value: row.id, label: localText(row.title) || row.id }))], marketCategory, value => { marketCategory = value }), selection('排序', [{ value: 'index', label: '索引顺序' }, { value: 'relevance', label: '相关性' }, { value: 'published', label: '最新发布' }], marketSort || (q ? 'relevance' : 'index'), value => { marketSort = value }))
      results.append(controls)
      if (!data.items.length) results.append(node('p', '没有找到插件；可输入完整包名查看详情。'))
      for (const item of data.items) {
        marketCompatibility.set(item.name + '@' + item.version, item.installSupported === false ? false : item.compatibility?.compatible)
        const el = card(localText(item.title) || item.name, localText(item.description))
        const status = { 'not-installed': '未安装', installed: '已安装', 'update-available': '有更新', 'different-version': '已安装其他版本', provided: '主机提供' }[item.installation?.status] || '安装状态未知'
        el.append(node('p', item.name + ' · ' + item.version + ' · ' + status + ' · ' + (item.compatibility?.compatible === true ? '符合主机版本要求' : item.compatibility?.compatible === false ? '不符合主机版本要求' : '兼容性未知')))
        if (item.installSupported === false) el.append(node('p', '此条目使用其他安装源；Remote 当前仅支持 npm 官方 registry 的安装，请在主机处理。'))
        const area = inlineArea(item.name), detail = button('查看详情', () => showDetails(item.name, item.version, area, detail))
        detail.className = 'pc-detail-button'; el.dataset.plugin = item.name; el.append(detail, area); renderInline(area, detail); results.append(el)
      }
      if (offset > 0) results.append(button('上一页', () => { offset = Math.max(0, offset - 20); return search() }))
      if (data.nextOffset !== null) results.append(button('下一页', () => { offset = data.nextOffset; return search() }))
    } catch (_) { if (sequence === searchSequence && current === generation && tab === 'market') results.replaceChildren(node('p', '官方索引暂时无法读取；以上适配信息仍可查看。', 'pc-market-note')) }
  }
  async function showDetails(name, version, area, control, force = false) {
    if (!area) {
      const el = card(name, ''), target = inlineArea(name)
      const detail = button('查看详情', () => showDetails(name, version, target, detail))
      detail.className = 'pc-detail-button'; el.append(detail, target); dialog.querySelector('.pc-detail').replaceChildren(el)
      area = target; control = detail
    }
    const key = area.dataset.key
    if (!force && expandedDetails.has(key)) { expandedDetails.delete(key); renderInline(area, control); return }
    const current = generation, entry = { name, version, kind: 'market', loading: true }
    expandedDetails.set(key, entry); renderInline(area, control)
    try {
      const { item } = await api('/details?name=' + encodeURIComponent(name) + (version ? '&version=' + encodeURIComponent(version) : ''))
      if (current !== generation || expandedDetails.get(key) !== entry) return
      entry.item = item; entry.loading = false
    } catch (error) {
      if (current !== generation || expandedDetails.get(key) !== entry) return
      entry.loading = false; entry.error = error.message
    }
    const target = currentArea(key)
    if (target) {
      const button = (target.parentElement || target.parent).querySelector('.pc-detail-button')
      renderInline(target, button)
    }
  }
  async function mutate(action, name, version) {
    if (pending) return
    const current = generation
    const reviewSequence = ++detailSequence
    // LAN HTTP is not a secure context; an idempotency key does not need WebCrypto.
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
    const body = { id, action, name, ...(version ? { version } : {}), revision: snapshot.revision }
    if (name === 'dsh-remote-plugin' && action === 'update') body.confirmSelfUpdate = true
    const area = dialog.querySelector('.pc-detail')
    let plan
    if (['install', 'update', 'remove'].includes(action)) {
      pending = true
      area.replaceChildren(node('p', '正在预检目标版本、锁文件与发布年龄策略…'))
      try {
        const response = await api('/preflight', body)
        if (current !== generation || reviewSequence !== detailSequence) return
        plan = response.plan
        if (!plan?.key) throw new Error('主机未返回可确认的预检计划，请升级主机 Remote 插件')
        body.preflightKey = plan.key
      } catch (error) {
        if (current !== generation || reviewSequence !== detailSequence) return
        area.replaceChildren(node('p', error.message, 'pc-detail-error'), button('重新预检', () => mutate(action, name, version)))
        return
      } finally { if (current === generation) pending = false }
    }
    if (current !== generation || reviewSequence !== detailSequence || !connection.valid()) return
    const review = card('确认' + labels[action], name + (version ? '@' + version : ''))
    review.append(node('p', '目标环境：' + snapshot.profile + '。配置修改后需要重启 DSH；不会自动重启。'))
    if (body.confirmSelfUpdate) review.append(node('p', '更新当前主机的 Remote 插件本体，先备份配置与旧包，后台执行。重启 DSH 后新版本生效，连接可能短暂中断；此操作不会升级手机 App。'))
    const confirm = button('确认' + labels[action], () => executeMutation(body)); confirm.className = action === 'remove' ? 'pc-danger-confirm' : 'pc-primary'
    if (plan) {
      review.append(node('p', '执行前备份全部插件文件和配置；安装后核验配置、锁文件与已安装版本。失败可在操作记录恢复更新前状态。'))
      if (plan.baselineWarning) review.append(node('p', '更新前已存在待修复状态：' + plan.baselineWarning + '。恢复备份会回到这一状态；只有安装后一致性核验通过才会报告完成。', 'pc-detail-error'))
      if (plan.blockers.length) {
        review.append(node('p', '以下版本尚未达到主机要求的 ' + plan.minutes + ' 分钟发布年龄；包含锁文件中可能与本次目标无关的包。'))
        for (const item of plan.blockers) review.append(node('p', item.name + '@' + item.version + ' · 发布于 ' + new Date(item.publishedAt).toLocaleString() + ' · 无需豁免的时间：' + new Date(item.eligibleAt).toLocaleString()))
      }
      if (plan.ruleChanges.length) {
        review.append(node('p', '批准后采用以下精确版本规则，并合并同名重复项：'))
        for (const rule of plan.ruleChanges) review.append(node('p', rule, 'pc-policy-rule'))
      }
      if (plan.blockers.length || plan.ruleChanges.length) {
        const label = node('label', null, 'pc-policy-consent'), checkbox = node('input')
        checkbox.type = 'checkbox'; checkbox.checked = false
        label.append(checkbox, node('span', '我信任以上明确版本，并批准列出的豁免与规则合并。'))
        confirm.disabled = true
        checkbox.addEventListener('change', () => { body.confirmReleasePolicy = checkbox.checked === true; confirm.disabled = !body.confirmReleasePolicy })
        review.append(label, node('p', '不批准也可取消，等待上述版本达到发布年龄后重新预检。'))
      }
    }
    review.append(confirm, button('取消', () => area.replaceChildren()))
    area.replaceChildren(review); area.scrollIntoView({ block: 'nearest' })
  }
  function reviewRestore(job) {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-restore`
    const body = { id, action: 'restore', name: job.name, revision: snapshot.revision, restoreFrom: job.id, confirmRestore: true }
    const review = card('确认恢复更新前状态', job.name)
    review.append(node('p', '恢复此任务备份的全部插件文件与配置，撤销本次安装及发布年龄豁免。失败后若有新改动或文件占用，将停止恢复并保留备份。恢复成功后需重启 DSH。'))
    review.append(button('确认恢复', () => executeMutation(body)), button('取消', () => dialog.querySelector('.pc-detail').replaceChildren()))
    dialog.querySelector('.pc-detail').replaceChildren(review)
  }
  async function executeMutation(body, endpoint = '/operations') {
    if (pending) return
    const current = generation
    pending = true
    if (tab !== 'market') { renderInstalled(); renderedInstalled = '' }
    for (const control of dialog.querySelector('.pc-detail').querySelectorAll('button')) control.disabled = true
    try {
      message('正在提交…')
      await api(endpoint, body)
      if (endpoint === '/operations') trackedOperation = body.id
      message('已受理，可在操作记录查看结果。')
      dialog.querySelector('.pc-detail').replaceChildren()
    } catch (error) {
      if (current !== generation) return
      if (error.status === 409 && body.preflightKey) {
        message(error.message)
        dialog.querySelector('.pc-detail').replaceChildren(button('重新预检', () => mutate(body.action, body.name, body.version)))
        return
      }
      message(error.message + '；请先查看操作记录，避免重复提交。')
      const retry = button('重试同一请求', () => executeMutation(body, endpoint))
      dialog.querySelector('.pc-detail').replaceChildren(retry)
    } finally { if (current === generation) { pending = false; await refresh() } }
  }
  function close() {
    window.DshSkillsCenter?.close()
    generation++; searchSequence++; detailSequence++; clearTimeout(timer); expandedDetails.clear()
    if (!dialog) return
    if (dialog.tagName === 'DIALOG') dialog.close()
    else { dialog.open = false; dialog.remove() }
    dialog = null
  }
  function startPolling() {
    clearTimeout(timer)
    const current = generation
    async function poll() {
      if (current !== generation || !dialog?.open) return
      try { await refresh() } catch (error) { if (current === generation) message(error.message) }
      if (current === generation && dialog?.open) timer = setTimeout(poll, 4000)
    }
    timer = setTimeout(poll, 4000)
  }
  function pause() { generation++; refreshSequence++; clearTimeout(timer); if (dialog) dialog.open = false }
  async function resume() {
    if (!dialog || !connection.valid()) return
    dialog.open = true; const current = ++generation
    try { await refresh() } catch (error) { if (current === generation) message(error.message) }
    if (current === generation && dialog?.open) startPolling()
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
          window.DshSkillsCenter?.close()
          tab = value; detailSequence++; expandedDetails.clear(); renderedInstalled = ''; dialog.querySelector('.pc-detail').replaceChildren()
          renderTabs(); message('')
          dialog.querySelector('.pc-market-tools').hidden = value !== 'market'; dialog.querySelector('.pc-filters').hidden = value === 'market'
          if (value === 'market') { offset = 0; return search() }
          return refresh()
        })
        control.dataset.pcTab = value; toolbar.append(control)
      }
      const refreshButton = button('刷新', () => tab === 'market' ? (offset = 0, search(true)) : refresh()); refreshButton.className = 'pc-refresh'
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
      const progress = node('section', null, 'pc-progress'); progress.hidden = true; progress.setAttribute('role', 'status'); progress.setAttribute('aria-live', 'polite')
      const alert = node('p', null, 'pc-message'); alert.setAttribute('role', 'status')
      const context = node('div', null, 'pc-context'); context.append(node('p', null, 'pc-profile'), node('div', null, 'pc-summary'))
      controls.append(toolbarRow, filters, market)
      dialog.append(heading, context, node('p', null, 'pc-status'), controls, alert, progress, node('div', null, 'pc-recovery'), node('div', null, 'pc-detail'), node('div', null, 'pc-list'), jobs)
      const surface = dialog
      dialog.addEventListener('close', () => {
        if (dialog !== surface) return
        window.DshSkillsCenter?.close()
        generation++; clearTimeout(timer); dialog = null; surface.remove()
      })
      ;(target || document.body).append(dialog)
    }
    generation++; searchSequence++; detailSequence++; marketCompatibility.clear(); marketIndex = ''; marketCategory = ''; marketSort = ''; fetchedAt = null; offset = 0; connection = config; tab = 'installed'; pending = false; snapshot = null; filter = ''; statusFilter = 'all'; trackedOperation = ''
    const current = generation
    renderedInstalled = ''; renderedJobs = ''
    dialog.querySelector('.pc-market-tools').hidden = true
    dialog.querySelector('.pc-detail').replaceChildren(); dialog.querySelector('.pc-list').replaceChildren(); dialog.querySelector('.pc-jobs').replaceChildren()
    if (target) dialog.open = true
    else dialog.showModal()
    message('正在读取插件状态…')
    try { await refresh(); message('') } catch (error) { if (current === generation) message(error.message) }
    if (current !== generation) return
    startPolling()
  }
  return { open, mount: (config, target) => open(config, target), close, pause, resume }
})()
