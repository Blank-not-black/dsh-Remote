/* AgentTeams view: reads only; scheduling remains owned by the host plugin. */
'use strict';
;(function(root) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  const text = (zh, en) => root.I18N?.lang === 'en' ? en : zh
  let current
  function status(value) {
    const names = { staged: ['待确认计划','Plan awaiting review'], running: ['运行中','Running'], working: ['工作中','Working'], idle: ['未运行','Idle'], unknown: ['未知','Unknown'],
      open: ['待执行','Open'], blocked: ['受阻','Blocked'], completed: ['已完成','Completed'], failed: ['失败','Failed'], cancelled: ['已取消','Cancelled'], in_progress: ['执行中','In progress'], removed: ['已移除','Removed'],
      pending: ['待审查','Pending review'], approved: ['已通过','Approved'], rejected: ['未通过','Rejected'], not_required: ['无需审查','Not required'],
      awaiting_review: ['等待计划审查','Awaiting plan review'], awaiting_feedback: ['等待审查反馈','Awaiting review feedback'] }
    return names[value] ? text(...names[value]) : value || text('未知','Unknown')
  }
  function teamHtml(team, index, archived) {
    const button = (label, member = '') => `<button class="ext-button${member ? '' : ' ext-button-primary'}" type="button" data-team-open="${index}"${member ? ` data-team-member="${esc(member)}"` : ''}>${esc(label)}<span aria-hidden="true">↗</span></button>`
    const badge = (value, title) => `<span class="ext-badge" data-tone="${['blocked','failed','rejected'].includes(value) ? 'attention' : ['working','running','in_progress'].includes(value) ? 'active' : 'neutral'}">${esc(title || status(value))}</span>`
    const members = (team.members || []).map(member => {
      const states = [...new Set([member.activity,member.status].filter(Boolean).map(status))]
      return `<li class="team-member"><div class="ext-panel-head"><strong>${esc(member.name)}</strong><span class="team-member-state">${states.map(esc).join(' · ')}</span></div>${member.role ? `<p class="ext-copy team-role">${esc(member.role)}</p>` : ''}<dl class="ext-facts team-member-facts">${member.provider || member.model ? `<div><dt>${esc(text('模型','Model'))}</dt><dd class="ext-identifier">${esc([member.provider,member.model].filter(Boolean).join(' / '))}</dd></div>` : ''}${member.currentTask ? `<div><dt>${esc(text('当前任务','Current task'))}</dt><dd class="ext-copy">${esc(member.currentTask)}</dd></div>` : ''}</dl>${!archived && member.id ? `<footer class="team-member-action">${button(text('打开成员记录','Open member record'), member.id)}</footer>` : ''}</li>`
    }).join('')
    const tasks = (team.tasks || []).map(task => `<li class="team-task"><div class="ext-panel-head"><strong>${esc(task.subject || task.id)}</strong>${badge(task.state || task.status)}</div>${task.subject && task.id ? `<span class="ext-identifier team-task-id">${esc(task.id)}</span>` : ''}${task.description ? `<p class="ext-copy">${esc(task.description)}</p>` : ''}<dl class="ext-facts"><div><dt>${esc(text('负责人','Assignee'))}</dt><dd>${esc(task.assignee || '—')}</dd></div><div><dt>${esc(text('依赖','Depends on'))}</dt><dd class="ext-identifier">${esc((task.dependencies || []).join(', ') || '—')}</dd></div></dl>${task.verdictStale ? `<p class="ext-alert ext-copy">${esc(task.verdictStale)}</p>` : ''}</li>`).join('')
    const delivery = team.deliverable === true && team.delivery?.ok === true ? text('插件报告可交付','Plugin reports deliverable') : text('交付尚未确认','Delivery not confirmed')
    const count = (label, value) => `<span>${esc(label)}<b>${value}</b></span>`
    const detail = (key, label, count, body, open = false) => `<details class="ext-disclosure"${open ? ' open' : ''} data-team-detail="${key}:${esc(team.teamId)}"><summary><span>${esc(label)}</span><span class="ext-count">${esc(count)}</span></summary><div class="ext-detail-body">${body}</div></details>`
    const blockers = team.delivery?.blockers || [], warnings = team.delivery?.warnings || []
    const attention = team.delivery?.ok === false || blockers.length || warnings.length
      ? `<aside class="ext-alert"><strong>${esc(team.delivery?.ok === false ? text('交付检查未通过','Delivery checks have not passed') : text('交付提醒','Delivery notes'))}</strong>${blockers.length ? `<ul aria-label="${esc(text('交付阻断','Delivery blockers'))}">${blockers.map(value => `<li class="ext-copy">${esc(value)}</li>`).join('')}</ul>` : ''}${warnings.length ? detail('warnings',text('交付警告','Delivery warnings'),warnings.length,`<ul>${warnings.map(value => `<li class="ext-copy">${esc(value)}</li>`).join('')}</ul>`) : ''}</aside>` : ''
    return `<article class="teams-card" data-team-id="${esc(team.teamId)}"><header class="ext-panel-head"><h3>${esc(team.name)}</h3>${badge(archived ? 'archived' : team.halted ? 'blocked' : team.phase, archived ? text('已归档','Archived') : team.halted ? text('已暂停调度','Scheduling halted') : status(team.phase))}</header>${team.description ? `<p class="ext-copy team-description">${esc(team.description)}</p>` : ''}<div class="team-overview">${count(text('成员','Members'),(team.members || []).length + (team.membersTruncated ? '+' : ''))}${count(text('任务','Tasks'),(team.tasks || []).length + (team.tasksTruncated ? '+' : ''))}${count(text('受阻','Blocked'),(team.tasks || []).filter(task => (task.state || task.status) === 'blocked').length)}</div><dl class="ext-facts team-checks">${team.planReviewState ? `<div><dt>${esc(text('计划审查','Plan review'))}</dt><dd>${esc(status(team.planReviewState))}</dd></div>` : ''}<div><dt>${esc(text('交付状态','Delivery'))}</dt><dd>${esc(delivery)}</dd></div></dl>${attention}<div class="team-captain-action">${button(text('打开队长会话','Open captain session'))}</div>${detail('members',text('成员','Members'),(team.members || []).length + (team.membersTruncated ? '+' : ''),`<ul class="team-members">${members || `<li class="ext-empty">${esc(text('暂无成员','No members'))}</li>`}</ul>`,true)}${detail('tasks',text('任务与依赖','Tasks and dependencies'),(team.tasks || []).length + (team.tasksTruncated ? '+' : ''),`<ul class="team-tasks">${tasks || `<li class="ext-empty">${esc(text('暂无任务','No tasks'))}</li>`}</ul>`)}${detail('messages',text('队长未读消息预览','Unread captain messages'),team.messageCount ?? '—',`<ul class="team-messages">${(team.captainInbox || []).map(row => `<li><strong>${esc(row.from)}</strong><p class="ext-copy">${esc(row.content)}</p></li>`).join('') || `<li class="ext-empty">${esc(text('暂无预览消息','No message previews'))}</li>`}</ul>`)}</article>`
  }
  function close() { if (current) { current.controller.abort(); clearInterval(current.timer); current = null } }
  async function mount(config, target) {
    close()
    const s = { config, target, controller: new AbortController(), request: 0, data: null, workspaceId: '', archived: false, expanded: new Map() }
    current = s
    const valid = () => current === s && config.valid()
    const workspaces = (config.getWorkspaces?.() || []).filter(w => w?.workspaceId)
    s.workspaceId = workspaces.some(w => w.workspaceId === config.getWorkspaceId?.()) ? config.getWorkspaceId() : workspaces[0]?.workspaceId || ''
    target.innerHTML = `<section class="teams-page"><div class="ext-heading"><span class="ext-eyebrow">${esc(text('协作概览','COLLABORATION'))}</span><h2>${esc(text('智能体团队','Agent teams'))}</h2><p>${esc(text('掌握团队进展，查看成员分工与交付阻断。','Follow team progress, member assignments and delivery blockers.'))}</p></div><div class="teams-controls ext-toolbar"><label class="ext-field ext-workspace">${esc(text('工作区','Workspace'))}<select data-teams-workspace>${workspaces.map(w => `<option value="${esc(w.workspaceId)}">${esc(w.title || w.path || w.workspaceId)}</option>`).join('')}</select></label><label class="ext-check"><input type="checkbox" data-teams-archived> ${esc(text('查看归档团队','Archived teams'))}</label><button class="ext-button" type="button" data-teams-refresh>${esc(text('刷新','Refresh'))}</button></div><p class="ext-note" data-teams-status role="status" aria-live="polite"></p><div class="teams-list" data-teams-content></div></section>`
    const selector = target.querySelector('[data-teams-workspace]'), content = target.querySelector('[data-teams-content]'), note = target.querySelector('[data-teams-status]')
    selector.value = s.workspaceId
    function render(data) {
      const key = JSON.stringify([data.teams,s.archived])
      if (key === s.renderKey) return
      s.renderKey = key
      const active = document.activeElement, focused = active?.closest?.('[data-team-open]')
      const focusedTeam = focused?.closest?.('[data-team-id]')?.dataset.teamId, focusedMember = focused?.dataset.teamMember || ''
      for (const detail of content.querySelectorAll('details[data-team-detail]')) s.expanded.set(detail.dataset.teamDetail, detail.open)
      content.innerHTML = data.teams.length ? data.teams.map((team, index) => teamHtml(team, index, s.archived)).join('') : `<p class="ext-empty">${esc(text('此工作区暂无团队。','No teams in this workspace.'))}</p>`
      for (const detail of content.querySelectorAll('details[data-team-detail]')) if (s.expanded.has(detail.dataset.teamDetail)) detail.open = s.expanded.get(detail.dataset.teamDetail)
      if (focusedTeam) [...content.querySelectorAll('[data-team-open]')].find(el => data.teams[Number(el.dataset.teamOpen)]?.teamId === focusedTeam && (el.dataset.teamMember || '') === focusedMember)?.focus({ preventScroll:true })
    }
    async function load(clear = false) {
      if (!valid()) { if (current === s) close(); return }
      s.readController?.abort()
      s.readController = new AbortController()
      const request = ++s.request
      if (clear) { s.data = null; s.renderKey = ''; s.expanded.clear(); content.replaceChildren() }
      if (!s.workspaceId) { note.textContent = text('请先登记一个 DSH 工作区。','Register a DSH workspace first.'); return }
      note.textContent = text('正在读取团队…','Loading teams…')
      try {
        const response = await fetch(config.url('/remote/api/teams?workspaceId=' + encodeURIComponent(s.workspaceId) + '&archived=' + (s.archived ? '1' : '0')), { headers: config.headers, signal: AbortSignal.any([s.controller.signal, s.readController.signal, AbortSignal.timeout(20000)]) })
        const body = await response.text()
        if (!valid() || request !== s.request) return
        if (body.length > 2 * 1024 * 1024) throw Error('large')
        const data = JSON.parse(body)
        if (!response.ok || data.ok !== true) { root.DshExtensions?.reportAvailability?.(config, 'teams', { code: response.status === 401 || response.status === 403 ? 'host-denied' : data.code || (response.status === 404 ? 'endpoint-missing' : 'read-failed') }); throw Error('read') }
        if (data.schema !== 1 || data.available !== false && (!Array.isArray(data.teams) || data.workspaceId !== s.workspaceId)) throw Error('schema')
        root.DshExtensions?.reportAvailability?.(config, 'teams', data)
        if (data.available === false) { s.data = null; s.renderKey = ''; content.replaceChildren(); note.textContent = data.code === 'endpoint-missing' ? text('主机团队接口尚未挂载。请核对插件是否启用，必要时重启 DSH 后刷新。','The host team endpoint is not mounted. Check that the plugin is enabled; restart DSH if needed, then refresh.') : text('主机未提供兼容的智能体团队接口。','No compatible AgentTeams endpoint on this host.'); return }
        render(data); s.data = data
        note.textContent = data.truncated ? text('团队较多，仅显示前 40 个。','Showing the first 40 teams.') : `${data.teams.length} ${text('个团队 · 已更新','teams · Updated')}`
      } catch (error) {
        if (valid() && request === s.request) {
          if (error.message !== 'read') root.DshExtensions?.reportAvailability?.(config, 'teams', { code: error.message === 'schema' ? 'unsupported' : error.name === 'TimeoutError' ? 'timeout' : 'read-failed' })
          note.textContent = s.data ? text('刷新失败，保留上次结果，可重试。','Refresh failed. Showing the previous result; retry is available.') : text('读取失败，请检查插件状态后重试。','Unable to load. Check plugin status and retry.')
        }
      }
    }
    selector.addEventListener('change', () => { s.workspaceId = selector.value; void load(true) })
    target.querySelector('[data-teams-archived]').addEventListener('change', event => { s.archived = event.target.checked; void load(true) })
    target.querySelector('[data-teams-refresh]').addEventListener('click', () => void load())
    content.addEventListener('click', async event => {
      const button = event.target.closest?.('[data-team-open]')
      if (!button || !valid() || !s.data) return
      const team = s.data.teams[Number(button.dataset.teamOpen)], member = button.dataset.teamMember
      if (!team || !team.captainSessionId) return
      button.disabled = true
      try { if (member) await config.openTeamMember?.(member, team.captainSessionId); else await config.openTeamCaptain?.(team.captainSessionId) }
      catch { if (valid()) note.textContent = text('会话暂不可读，请刷新后重试。','Session unavailable. Refresh and retry.') }
      finally { if (valid()) button.disabled = false }
    })
    s.timer = setInterval(() => { if (!document.hidden) void load() }, 15000)
    await load()
  }
  const api = { mount, close, teamHtml }
  root.DshTeams = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window === 'undefined' ? globalThis : window)
