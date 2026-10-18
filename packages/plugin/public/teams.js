/* AgentTeams view: reads only; scheduling remains owned by the host plugin. */
'use strict';
;(function(root) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  const text = (zh, en) => root.I18N?.lang === 'en' ? en : zh
  let current
  function status(value) {
    const names = { staged: ['待确认计划','Plan awaiting review'], running: ['运行中','Running'], working: ['工作中','Working'], idle: ['未运行','Idle'], unknown: ['未知','Unknown'],
      open: ['待执行','Open'], blocked: ['受阻','Blocked'], completed: ['已完成','Completed'], failed: ['失败','Failed'], cancelled: ['已取消','Cancelled'], in_progress: ['执行中','In progress'], removed: ['已移除','Removed'] }
    return names[value] ? text(...names[value]) : value || text('未知','Unknown')
  }
  function teamHtml(team, index, archived) {
    const button = (label, member = '') => `<button type="button" data-team-open="${index}"${member ? ` data-team-member="${esc(member)}"` : ''}>${esc(label)}</button>`
    const members = (team.members || []).map(member => `<li><div><strong>${esc(member.name)}</strong> · ${esc(status(member.activity))} · ${esc(status(member.status))}</div><p>${esc(member.role)}</p><small>${esc([member.provider,member.model].filter(Boolean).join('/'))} ${esc(member.currentTask)}</small>${!archived && member.id ? button(text('打开成员记录','Open member record'), member.id) : ''}</li>`).join('')
    const tasks = (team.tasks || []).map(task => `<li><strong>${esc(task.id)} · ${esc(task.subject)}</strong><span class="teams-state">${esc(status(task.state || task.status))}</span><p>${esc(task.description)}</p><small>${esc(text('负责人','Assignee'))}：${esc(task.assignee || '—')} · ${esc(text('依赖','Depends on'))}：${esc((task.dependencies || []).join(', ') || '—')}</small>${task.verdictStale ? `<p class="teams-error">${esc(task.verdictStale)}</p>` : ''}</li>`).join('')
    const delivery = team.deliverable === true && team.delivery?.ok === true ? text('插件报告可交付','Plugin reports deliverable') : text('交付尚未确认','Delivery not confirmed')
    return `<article class="teams-card"><header><h3>${esc(team.name)}</h3><span>${esc(archived ? text('已归档','Archived') : team.halted ? text('已暂停调度','Scheduling halted') : status(team.phase))}</span></header><p>${esc(team.description)}</p><p>${esc(delivery)}</p>${team.delivery?.blockers?.length ? `<ul>${team.delivery.blockers.map(v => `<li>${esc(v)}</li>`).join('')}</ul>` : ''}${button(text('打开队长会话','Open captain session'))}<details open data-team-detail="members:${esc(team.teamId)}"><summary>${esc(text('成员','Members'))} · ${(team.members || []).length}${team.membersTruncated ? '+' : ''}</summary><ul>${members || `<li>${esc(text('暂无成员','No members'))}</li>`}</ul></details><details data-team-detail="tasks:${esc(team.teamId)}"><summary>${esc(text('任务与依赖','Tasks and dependencies'))} · ${(team.tasks || []).length}${team.tasksTruncated ? '+' : ''}</summary><ul>${tasks || `<li>${esc(text('暂无任务','No tasks'))}</li>`}</ul></details><details data-team-detail="messages:${esc(team.teamId)}"><summary>${esc(text('队长未读消息预览','Unread captain messages'))} · ${team.messageCount ?? '—'}</summary>${(team.captainInbox || []).map(row => `<p><strong>${esc(row.from)}</strong>：${esc(row.content)}</p>`).join('') || `<p>${esc(text('暂无预览消息','No message previews'))}</p>`}</details></article>`
  }
  function close() { if (current) { current.controller.abort(); clearInterval(current.timer); current = null } }
  async function mount(config, target) {
    close()
    const s = { config, target, controller: new AbortController(), request: 0, data: null, workspaceId: '', archived: false, expanded: new Map() }
    current = s
    const valid = () => current === s && config.valid()
    const workspaces = (config.getWorkspaces?.() || []).filter(w => w?.workspaceId)
    s.workspaceId = workspaces.some(w => w.workspaceId === config.getWorkspaceId?.()) ? config.getWorkspaceId() : workspaces[0]?.workspaceId || ''
    target.innerHTML = `<section class="teams-page"><h2>${esc(text('智能体团队','Agent teams'))}</h2><p>${esc(text('查看当前工作区的团队、成员、任务依赖与消息。','Teams, members, dependencies and messages in the selected workspace.'))}</p><div class="teams-controls"><label>${esc(text('工作区','Workspace'))}<select data-teams-workspace>${workspaces.map(w => `<option value="${esc(w.workspaceId)}">${esc(w.title || w.path || w.workspaceId)}</option>`).join('')}</select></label><label><input type="checkbox" data-teams-archived> ${esc(text('查看归档团队','Archived teams'))}</label><button type="button" data-teams-refresh>${esc(text('刷新','Refresh'))}</button></div><p data-teams-status role="status" aria-live="polite"></p><div data-teams-content></div></section>`
    const selector = target.querySelector('[data-teams-workspace]'), content = target.querySelector('[data-teams-content]'), note = target.querySelector('[data-teams-status]')
    selector.value = s.workspaceId
    function render(data) {
      for (const detail of content.querySelectorAll('details[data-team-detail]')) s.expanded.set(detail.dataset.teamDetail, detail.open)
      content.innerHTML = data.teams.length ? data.teams.map((team, index) => teamHtml(team, index, s.archived)).join('') : `<p>${esc(text('此工作区暂无团队。','No teams in this workspace.'))}</p>`
      for (const detail of content.querySelectorAll('details[data-team-detail]')) if (s.expanded.has(detail.dataset.teamDetail)) detail.open = s.expanded.get(detail.dataset.teamDetail)
    }
    async function load(clear = false) {
      if (!valid()) { if (current === s) close(); return }
      s.readController?.abort()
      s.readController = new AbortController()
      const request = ++s.request
      if (clear) { s.data = null; s.expanded.clear(); content.replaceChildren() }
      if (!s.workspaceId) { note.textContent = text('请先登记一个 DSH 工作区。','Register a DSH workspace first.'); return }
      note.textContent = text('正在读取团队…','Loading teams…')
      try {
        const response = await fetch(config.url('/remote/api/teams?workspaceId=' + encodeURIComponent(s.workspaceId) + '&archived=' + (s.archived ? '1' : '0')), { headers: config.headers, signal: AbortSignal.any([s.controller.signal, s.readController.signal, AbortSignal.timeout(20000)]) })
        const body = await response.text()
        if (!valid() || request !== s.request) return
        if (body.length > 2 * 1024 * 1024) throw Error('large')
        const data = JSON.parse(body)
        if (!response.ok || data.ok !== true || data.schema !== 1 || data.available !== false && (!Array.isArray(data.teams) || data.workspaceId !== s.workspaceId)) throw Error('schema')
        if (data.available === false) { s.data = null; content.replaceChildren(); note.textContent = text('主机未提供兼容的智能体团队接口。','No compatible AgentTeams endpoint on this host.'); return }
        render(data); s.data = data
        note.textContent = data.truncated ? text('团队较多，仅显示前 40 个。','Showing the first 40 teams.') : text('已更新','Updated')
      } catch {
        if (valid() && request === s.request) note.textContent = s.data ? text('刷新失败，保留上次结果，可重试。','Refresh failed. Showing the previous result; retry is available.') : text('读取失败，请检查插件状态后重试。','Unable to load. Check plugin status and retry.')
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
