/* Task board: a bounded read-only view of the selected host workspace. */
;(function(root) {
  'use strict'
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]))
  const text = (zh, en) => root.I18N?.lang === 'en' ? en : zh
  const statuses = { backlog: ['待整理','Backlog'], todo: ['待执行','To do'], running: ['运行中','Running'], done: ['已完成','Done'], failed: ['失败','Failed'],
    succeeded: ['执行成功','Run succeeded'], cancelled: ['已取消','Cancelled'], unknown: ['未知','Unknown'] }
  const label = value => statuses[value] ? text(...statuses[value]) : text('未知','Unknown')
  const date = (value, zone) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
    try { return new Date(value).toLocaleString(root.I18N?.lang === 'en' ? 'en-GB' : 'zh-CN', { timeZone: zone || undefined }) }
    catch { return text('时间或时区不可用','Time or timezone unavailable') }
  }
  function taskHtml(task, index, timeZone) {
    const run = task.executions?.at(-1), verification = run?.verification
    const accepted = verification?.stage === 'quality' && verification.passed === true && !verification.inFlight && !verification.failedReason
    const verdict = !verification ? text('未提供验收记录','No verification record') : verification.inFlight ? text('验收中','Verification running')
      : verification.applicability !== 'enforced' ? text('未启用独立验收','Independent verification not enforced') : accepted ? text('验收记录通过','Verification record passed')
      : verification.stage === 'quality' && verification.passed === false ? text('验收未通过','Verification did not pass') : text('尚无有效验收通过记录','No valid passing verification record')
    const schedule = task.schedule
    const errors = [...new Set([run?.error,verification?.failedReason].filter(Boolean))]
    const tone = task.status === 'running' ? 'active' : task.status === 'failed' ? 'attention' : 'neutral'
    return `<article class="task-card" data-task-id="${esc(task.id)}"><header class="ext-panel-head"><h3>${esc(task.title || text('未命名任务','Untitled task'))}</h3><span class="ext-badge" data-tone="${tone}">${esc(label(task.status))}${task.archivedAt ? ' · ' + esc(text('已归档','Archived')) : ''}</span></header>
      ${task.description ? `<p class="ext-copy task-description">${esc(task.description)}</p>` : ''}<dl class="ext-facts task-outcomes"><div><dt>${esc(text('最近执行','Latest run'))}</dt><dd>${esc(run ? run.result ? label(run.result) : run.endedAt ? text('结果未知','Outcome unknown') : text('执行尚未结束','Run has not ended') : text('尚无执行记录','No execution record'))}${run?.external ? `<small>${esc(text('外部报告','Externally reported'))}</small>` : ''}</dd></div><div><dt>${esc(text('独立验收','Verification'))}</dt><dd>${esc(verdict)}</dd></div></dl>
      ${errors.length ? `<aside class="ext-alert"><strong>${esc(text('需要关注','Needs attention'))}</strong>${errors.map(error => `<p class="ext-copy">${esc(error)}</p>`).join('')}</aside>` : ''}
      ${schedule ? `<div class="task-schedule"><div class="task-schedule-head"><span>${esc(text('执行计划','Schedule'))}</span><span>${esc(schedule.enabled ? text('已启用','Enabled') : text('未启用','Disabled'))}</span></div><p class="task-schedule-rule">${esc(schedule.mode === 'once' ? text('单次执行','Run once') : schedule.mode === 'cron' ? schedule.cron : text('未知计划','Unknown schedule'))}</p>${schedule.enabled ? `<dl class="ext-facts"><div><dt>${esc(text('下次执行','Next run'))}</dt><dd>${esc(date(schedule.nextRunAt,schedule.timeZone || timeZone))}<small>${esc(schedule.timeZone || timeZone || text('时区未知','Timezone unknown'))}</small></dd></div></dl>` : ''}</div>` : ''}
      ${run?.summary ? `<details class="ext-disclosure" data-task-detail="${esc(task.id)}"><summary><span>${esc(text('最近执行摘要','Latest run summary'))}</span></summary><div class="ext-detail-body ext-copy">${esc(run.summary)}</div></details>` : ''}
      ${task.parentId ? `<dl class="ext-facts task-parent"><div><dt>${esc(text('父任务','Parent task'))}</dt><dd class="ext-identifier">${esc(task.parentId)}</dd></div></dl>` : ''}
      <footer class="task-footer"><span>${esc(text('更新于','Updated'))}<time>${esc(date(task.updatedAt,timeZone))}</time></span>${run?.sessionId ? `<button class="ext-button" type="button" data-task-open="${index}">${esc(text('打开执行会话','Open execution session'))}<span aria-hidden="true">↗</span></button>` : ''}</footer></article>`
  }
  let current
  function close() { if (current) { current.controller.abort(); clearInterval(current.timer); current = null } }
  async function mount(config, target) {
    close()
    const workspaces = (config.getWorkspaces?.() || []).filter(row => row?.workspaceId)
    const s = { config, target, controller: new AbortController(), request: 0, data: null, expanded: new Set() }
    current = s
    const valid = () => current === s && config.valid()
    s.workspaceId = workspaces.find(row => row.workspaceId === config.getWorkspaceId?.())?.workspaceId || workspaces[0]?.workspaceId || ''
    target.innerHTML = `<section class="task-board"><div class="ext-heading"><span class="ext-eyebrow">${esc(text('工作概览','WORK OVERVIEW'))}</span><h2>${esc(text('任务看板','Task board'))}</h2><p>${esc(text('跟进任务进度、执行结果与验收状态。','Track task progress, execution results and verification.'))}</p></div>
      <div class="task-controls ext-toolbar"><label class="ext-field ext-workspace">${esc(text('工作区','Workspace'))}<select data-task-workspace>${workspaces.map(row => `<option value="${esc(row.workspaceId)}">${esc(row.title || row.workspaceId)}</option>`).join('')}</select></label>
      <label class="ext-field">${esc(text('状态','Status'))}<select data-task-status><option value="">${esc(text('全部状态','All statuses'))}</option>${Object.keys(statuses).slice(0,5).map(value => `<option value="${value}">${esc(label(value))}</option>`).join('')}</select></label>
      <label class="ext-field ext-search">${esc(text('搜索','Search'))}<input type="search" data-task-search placeholder="${esc(text('搜索任务','Search tasks'))}"></label><label class="ext-check"><input type="checkbox" data-task-archived> ${esc(text('显示归档任务','Show archived tasks'))}</label>
      <button class="ext-button" type="button" data-task-refresh>${esc(text('刷新','Refresh'))}</button></div><p class="ext-note task-scope">${esc(text('只读查看当前工作区，未指定工作区的任务不在此列表。','Read-only view of this workspace; unassigned tasks are excluded.'))}</p><div class="task-summary"><p class="ext-note" data-task-count></p><p class="ext-note" role="status" aria-live="polite" data-task-note></p></div><div class="task-list" data-task-content></div></section>`
    const selector = target.querySelector('[data-task-workspace]'), filter = target.querySelector('[data-task-status]'), search = target.querySelector('[data-task-search]')
    const archived = target.querySelector('[data-task-archived]'), content = target.querySelector('[data-task-content]'), note = target.querySelector('[data-task-note]'), count = target.querySelector('[data-task-count]')
    selector.value = s.workspaceId; filter.value = ''; search.value = ''; archived.checked = false
    function render() {
      if (!valid() || !s.data) return
      const query = search.value.trim().toLowerCase(), renderKey = JSON.stringify([s.data.tasks,s.data.timeZone,query,filter.value,archived.checked])
      if (renderKey === s.renderKey) return
      s.renderKey = renderKey
      const focusedTask = document.activeElement?.closest?.('[data-task-id]')?.dataset.taskId
      for (const el of content.querySelectorAll('details')) { if (el.open) s.expanded.add(el.dataset.taskDetail); else s.expanded.delete(el.dataset.taskDetail) }
      const rows = s.data.tasks.map((task, index) => ({ task, index })).filter(({ task }) => (!filter.value || task.status === filter.value) && (archived.checked || !task.archivedAt)
        && [task.title,task.description].join(' ').toLowerCase().includes(query))
      count.textContent = `${text('显示','Showing')} ${rows.length}${rows.length !== s.data.tasks.length ? ' / ' + s.data.tasks.length : ''} ${text('个任务','tasks')}`
      content.innerHTML = rows.length ? rows.map(({ task,index }) => taskHtml(task,index,s.data.timeZone)).join('') : `<p class="ext-empty">${esc(text('没有匹配的任务。','No matching tasks.'))}</p>`
      for (const el of content.querySelectorAll('details')) el.open = s.expanded.has(el.dataset.taskDetail)
      if (focusedTask) [...content.querySelectorAll('[data-task-open]')].find(el => s.data.tasks[Number(el.dataset.taskOpen)]?.id === focusedTask)?.focus({ preventScroll:true })
    }
    async function load(clear = false) {
      if (!valid()) { if (current === s) close(); return }
      if (s.loading && !clear) return
      s.readController?.abort(); s.readController = new AbortController()
      const request = ++s.request; s.loading = true
      if (clear) { s.data = null; s.renderKey = ''; s.expanded.clear(); content.replaceChildren(); count.textContent = '' }
      if (!s.workspaceId) { s.loading = false; note.textContent = text('请先登记一个 DSH 工作区。','Register a DSH workspace first.'); return }
      note.textContent = text('正在读取任务…','Loading tasks…')
      try {
        const response = await fetch(config.url('/remote/api/task-board?workspaceId=' + encodeURIComponent(s.workspaceId)), { headers: config.headers,
          signal: AbortSignal.any([s.controller.signal,s.readController.signal,AbortSignal.timeout(25000)]) })
        const body = await response.text()
        if (!valid() || request !== s.request) return
        if (body.length > 2 * 1024 * 1024) throw Error('large')
        const data = JSON.parse(body)
        if (!response.ok || data.ok !== true) { root.DshExtensions?.reportAvailability?.(config,'tasks',{ code: response.status === 401 || response.status === 403 ? 'host-denied' : data.code || (response.status === 404 ? 'not-installed' : 'read-failed') }); throw Error('read') }
        if (data.schema !== 1 || data.available !== false && (!Array.isArray(data.tasks) || data.source !== 'task-board' || data.workspaceId !== s.workspaceId)) throw Error('schema')
        root.DshExtensions?.reportAvailability?.(config,'tasks',data)
        if (data.available === false) { s.data = null; s.renderKey = ''; content.replaceChildren(); count.textContent = ''; note.textContent = text('主机未提供兼容的任务看板服务，请返回插件列表查看诊断。','No compatible task-board service. Check diagnostics in the plugin list.'); return }
        s.data = data; render()
        note.textContent = (data.truncated ? text('仅载入前 200 个任务 · ','Loaded the first 200 tasks · ') : text('已更新 · ','Updated · ')) + date(data.generatedAt, data.timeZone)
      } catch (error) {
        if (valid() && request === s.request) {
          if (error.message !== 'read') root.DshExtensions?.reportAvailability?.(config,'tasks',{ code: error.message === 'schema' ? 'unsupported' : error.name === 'TimeoutError' ? 'timeout' : 'read-failed' })
          note.textContent = s.data ? text('刷新失败，保留上次结果，可重试。','Refresh failed. Showing the previous result; retry available.') : text('读取失败，请重试或查看插件诊断。','Read failed. Retry or check plugin diagnostics.')
        }
      } finally { if (request === s.request) s.loading = false }
    }
    selector.addEventListener('change', () => { if (!valid()) return; s.workspaceId = selector.value; void load(true) })
    filter.addEventListener('change', render); search.addEventListener('input', render); archived.addEventListener('change', render)
    target.querySelector('[data-task-refresh]').addEventListener('click', () => void load())
    content.addEventListener('click', async event => {
      const button = event.target.closest?.('[data-task-open]')
      if (!button || !valid() || !s.data) return
      const task = s.data.tasks[Number(button.dataset.taskOpen)], sessionId = task?.executions?.at(-1)?.sessionId
      if (!sessionId || !config.openTaskSession) return
      button.disabled = true
      try { await config.openTaskSession(sessionId,s.workspaceId) }
      catch { if (valid()) note.textContent = text('执行会话暂不可用，请刷新后重试。','Execution session unavailable. Refresh and retry.') }
      finally { if (valid()) button.disabled = false }
    })
    s.timer = setInterval(() => { if (valid() && !document.hidden) void load(); else if (!valid()) close() }, 15000)
    await load()
  }
  const api = { mount, close, taskHtml }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.DshTasks = api
})(typeof window === 'undefined' ? globalThis : window)
