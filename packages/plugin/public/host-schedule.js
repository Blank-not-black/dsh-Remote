;(function (root) {
  'use strict'
  const tr = (zh, en) => root.I18N?.lang === 'en' ? en : zh
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
  const kinds = { at: ['指定时间', 'At a date and time'], after: ['延时一次', 'One-time delay'], every: ['固定间隔', 'Fixed interval'], daily: ['每天', 'Daily'], weekly: ['每周', 'Weekly'], cron: ['Cron', 'Cron'], rrule: ['RRULE', 'RRULE'] }
  const destinations = { session: ['复用现有会话', 'Reuse an existing session'], new_once: ['首次新建，之后复用', 'Create once, then reuse'], new: ['每次新建会话', 'Create a session each time'] }
  const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const stateLabels = { active: ['启用', 'Active'], paused: ['已暂停', 'Paused'], ended: ['已结束', 'Ended'], inactive: ['未启用', 'Inactive'] }
  const executionLabels = { pending: ['已投递 · 仍在收件箱', 'Delivered · still in inbox'], running: ['执行中', 'Running'], completed: ['执行完成', 'Turn completed'], aborted: ['执行中止', 'Turn aborted'], failed: ['执行失败或未完成', 'Turn failed or did not complete'], unverified: ['已投递 · 执行状态未证实', 'Delivered · execution unverified'] }
  const field = (values, name) => String(values[name] ?? '').trim()
  const localTime = value => /^\d\d:\d\d$/.test(value) ? value + ':00' : value

  function timing(values) {
    const kind = values.kind, value = field(values, 'timingValue'), zone = field(values, 'zone')
    if (!value) throw new Error(tr('请填写触发时间或重复规则。', 'Enter a trigger time or repeat rule.'))
    if (kind === 'after' || kind === 'every') {
      const seconds = Number(value)
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(seconds) || seconds < (kind === 'after' ? 1 : 60)) throw new Error(tr('请输入合法的秒数（固定间隔至少 60 秒）。', 'Enter valid seconds (at least 60 for a fixed interval).'))
      return { kind, [kind + '_seconds']: seconds }
    }
    if (kind === 'rrule') return { kind, rrule: value.replace(/\r\n/g, '\n') }
    if (kind === 'at' && /T.*(?:Z|[+-]\d\d:\d\d)$/i.test(value)) return { kind, at: value }
    if (!zone) throw new Error(tr('请填写 IANA 时区。', 'Enter an IANA time zone.'))
    try { new Intl.DateTimeFormat('en', { timeZone: zone }) } catch { throw new Error(tr('无法识别此 IANA 时区。', 'Unrecognized IANA time zone.')) }
    if (kind === 'at') {
      const match = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?)$/.exec(value)
      if (!match) throw new Error(tr('请输入「年-月-日 时:分」或带偏移的 RFC 3339 时间。', 'Use YYYY-MM-DD HH:mm or an RFC 3339 timestamp with an offset.'))
      return { kind, at: { date: match[1], time: localTime(match[2]), time_zone: zone } }
    }
    if (kind === 'cron') return { kind, cron: { expression: value, time_zone: zone } }
    if (kind === 'daily') return { kind, daily: { time: localTime(value), time_zone: zone } }
    if (kind === 'weekly') {
      const weekdays = field(values, 'weekdays').split(/[,，\s]+/).filter(Boolean).map(Number)
      if (!weekdays.length || weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7) || new Set(weekdays).size !== weekdays.length) throw new Error(tr('请输入不重复的星期编号 1–7（周一至周日）。', 'Enter distinct weekday numbers 1–7 (Monday through Sunday).'))
      return { kind, weekly: { time: localTime(value), time_zone: zone, weekdays: weekdays.sort((left, right) => left - right) } }
    }
    throw new Error(tr('主机规则类型不可编辑。', 'This Host rule type is not editable.'))
  }

  function initial(task) {
    const kind = task?.kind || 'at'
    return { title: task?.title || '', prompt: task?.prompt || '', kind, zone: task?.timeZone || timeZone(),
      timingValue: String(({ at: task?.scheduledAt, after: task?.afterSeconds, every: task?.everySeconds, daily: task?.time, weekly: task?.time, cron: task?.expression, rrule: task?.rrule })[kind] ?? ''),
      weekdays: task?.weekdays?.join(',') || '', destination: task?.target?.kind || 'new_once',
      sessionId: task?.target?.sessionId || '', cwd: task?.target?.create?.cwd || '' }
  }

  function changes(values, before, task) {
    const patch = {}
    for (const name of ['title', 'prompt']) {
      if (!field(values, name)) throw new Error(tr('请填写名称和任务内容。', 'Enter a name and task instructions.'))
      if (!task || field(values, name) !== before[name]) patch[name] = field(values, name)
    }
    if (!task || ['kind', 'zone', 'timingValue', 'weekdays'].some(name => values[name] !== before[name])) patch.timing = timing(values)
    const targetChanged = values.destination !== before.destination || (values.destination === 'session' ? values.sessionId !== before.sessionId : values.cwd !== before.cwd)
    if (!task || targetChanged) {
      const kind = values.destination
      if (kind === 'session') {
        if (!values.sessionId) throw new Error(tr('请选择要复用的会话。', 'Choose a session to reuse.'))
        patch.target = { kind, sessionId: values.sessionId }
      } else if (kind === 'new' || kind === 'new_once') {
        const agentPreset = task?.target?.create?.agentPreset
        patch.target = { kind, create: { ...(values.cwd ? { cwd: values.cwd } : {}), ...(agentPreset ? { agentPreset } : {}) } }
      } else throw new Error(tr('请选择投递目标。', 'Choose a delivery target.'))
    }
    return patch
  }

  function create(config) {
    const limit = 30, historyLimit = 10
    let connection, read = 0, offset = 0, rows = [], total = 0, writable = false, loaded = false
    let loading = false, error = '', feedback = '', writing = null, dialog, history = null
    const box = config.box
    const active = () => !!box() && !box().classList.contains('hidden')
    const valid = entry => entry && entry === connection && entry.valid() && active()
    const taskLabel = task => tr(...(stateLabels[task.status] || [task.status || '未知', task.status || 'Unknown']))
    const formatTime = (value, zone = timeZone()) => {
      if (!value || !Number.isFinite(Date.parse(value))) return '—'
      try { return new Intl.DateTimeFormat(root.I18N?.lang === 'en' ? 'en' : 'zh-CN', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) + ' · ' + zone }
      catch { return String(value) }
    }
    function explain(err) {
      if (root.DshHostQueue.denied(err)) return tr('此设备无权执行此操作。', 'This device cannot perform this operation.')
      switch (err?.code) {
        case 'schedule/unsupported': return tr('此主机未启用或不支持所需的 Schedule 接口。请在主机更新或启用 Schedule。', 'This Host does not expose the required Schedule API. Update the Host or enable Schedule there.')
        case 'schedule_conflict': return tr('任务已被其他客户端修改，请刷新后重新编辑。', 'Another client changed this task. Refresh and reopen the editor.')
        case 'schedule_not_found': return tr('任务已不存在。', 'This task no longer exists.')
        case 'delivery_cursor_not_found': return tr('历史已变化，请重新读取该任务的投递记录。', 'History changed. Reload the task’s deliveries.')
        case 'schedule_execution_pending': return tr('已有一次投递正在等待或执行，或仍在主机限制间隔内。', 'A delivery is pending, in progress, or within the Host delivery interval.')
        case 'schedule/input-invalid': return tr('主机未接受任务设置，请核对时间、时区、重复规则和目标。', 'The Host rejected these settings. Check the time, time zone, repeat rule and target.')
        case 'schedule/target-archived': return tr('目标会话已归档，请更换目标或在主机恢复会话。', 'The target session is archived. Change the target or restore it on the Host.')
        default: return err?.message || tr('无法读取主机自动化。', 'Could not read Host automations.')
      }
    }

    async function refresh(reloadHistory = false) {
      if (!active()) return
      if (!connection?.valid()) {
        connection = config.capture()
        offset = 0; rows = []; total = 0; history = null; writable = false; feedback = ''; loaded = false
        dialog?.close()
      }
      const entry = connection, revision = ++read
      loading = true; error = ''
      render()
      try {
        if (!entry.token) throw new Error(tr('请先连接主机。', 'Connect to a Host first.'))
        const [page, access] = await Promise.all([config.rpc('schedule.list', { limit, offset }), config.access(entry)])
        if (!valid(entry) || revision !== read) return
        if (!Array.isArray(page?.items) || !Number.isSafeInteger(page.total)) throw new Error(tr('网关或主机未提供兼容的自动化列表。', 'The Gateway or Host does not provide a compatible automation list.'))
        if (offset && !page.items.length) { offset = Math.max(0, Math.floor((page.total - 1) / limit) * limit); return await refresh(reloadHistory) }
        rows = page.items; total = page.total; writable = access; loaded = true
        if (reloadHistory && history) void readHistory(history.task, undefined)
      } catch (err) {
        if (!valid(entry) || revision !== read) return
        writable = false; loaded = false; error = explain(err)
      } finally {
        if (valid(entry) && revision === read) { loading = false; render() }
      }
    }

    async function write(method, payload, task) {
      const entry = connection
      if (!valid(entry) || writing || loading || !loaded || !writable) return false
      writing = entry; feedback = ''
      render()
      let attempted = false, succeeded = false
      try {
        if (!await config.access(entry) || !valid(entry)) throw new Error('host-state/access-denied')
        if (task) {
          const fresh = await config.rpc('schedule.view', { id: task.id })
          if (fresh?.code || fresh?.id !== task.id) throw Object.assign(new Error(), { code: fresh?.code || 'schedule_not_found' })
          if ((fresh.updatedAt ?? null) !== (task.updatedAt ?? null)) throw Object.assign(new Error(), { code: 'schedule_conflict' })
        }
        if (!valid(entry)) return false
        attempted = true
        const result = await config.rpc(method, payload)
        if (result?.code) throw Object.assign(new Error(), { code: result.code })
        if (!result?.id || (payload.action === 'delete' && result.deleted !== true)) throw new Error()
        succeeded = true
        if (valid(entry)) {
          if (payload.action === 'delete' && history?.task.id === payload.id) history = null
          feedback = method === 'schedule.run' ? tr('主机已确认投递；这不是执行完成。', 'The Host confirmed delivery, not completion.') : tr('主机已保存更改。', 'The Host saved the change.')
        }
      } catch (err) {
        if (valid(entry)) feedback = !attempted || root.DshHostQueue.knownRejection(err) ? explain(err)
          : tr('写入结果未确认。不会重发；请核对主机最新列表和记录。', 'Write unconfirmed. It was not retried; check the refreshed Host list and records.')
      } finally {
        if (valid(entry)) await refresh(true)
        writing = null
        if (active()) render()
      }
      return succeeded && valid(entry)
    }

    async function readHistory(task, before) {
      const entry = connection
      if (!valid(entry)) return
      if (!before) history = { task, records: [], execution: new Map() }
      if (history?.task.id !== task.id || history.busy) return
      const current = history
      current.busy = true; current.error = ''
      render()
      try {
        const page = await config.rpc('schedule.history', { id: task.id, limit: historyLimit, ...(before ? { before } : {}) })
        if (!valid(entry) || current !== history) return
        if (page?.code) throw Object.assign(new Error(tr('该记录已不可用，请刷新。', 'History is no longer available; refresh to try again.')), { code: page.code })
        if (!Array.isArray(page?.records)) throw new Error(tr('主机未返回有效的投递记录。', 'The Host returned no valid delivery records.'))
        const prior = new Set(current.records.map(record => record.messageId))
        current.records.push(...page.records.filter(record => !prior.has(record.messageId)))
        current.next = page.nextBefore
        current.partial = page.earlierRecordsUnavailable || page.earlierRecordsPruned
        if (!before && current.records[0]) void checkExecution(current.records[0])
      } catch (err) { if (valid(entry) && current === history) current.error = explain(err) }
      finally { if (valid(entry) && current === history) { current.busy = false; render() } }
    }

    async function checkExecution(record) {
      const entry = connection, current = history
      if (!valid(entry) || !current || current.execution.get(record.messageId) === 'checking') return
      current.execution.set(record.messageId, 'checking'); render()
      try {
        const value = await config.rpc('session.deliveryStatus', { sessionId: record.targetSessionId, messageId: record.messageId })
        if (valid(entry) && history === current) current.execution.set(record.messageId, Object.hasOwn(executionLabels, value?.status) ? value.status : 'unverified')
      } catch { if (valid(entry) && history === current) current.execution.set(record.messageId, 'unverified') }
      finally { if (valid(entry) && history === current) render() }
    }

    function form(task) {
      if (writing || loading || !writable || !loaded) return
      const entry = connection, before = initial(task)
      if (!dialog) {
        dialog = root.document.createElement('dialog')
        dialog.className = 'host-state-dialog'
        dialog.setAttribute('aria-labelledby', 'host-schedule-editor-title')
        root.document.body.append(dialog)
      }
      const options = (values, selected) => values.map(([value, label]) => `<option value="${esc(value)}" ${selected === value ? 'selected' : ''}>${esc(label)}</option>`).join('')
      const workspaceChoices = config.workspaces().filter(row => row.path).map(row => [row.path, row.title || row.name || row.path])
      const sessionChoices = config.sessions().map(row => [row.id, row.label])
      if (before.cwd && !workspaceChoices.some(([path]) => path === before.cwd)) workspaceChoices.unshift([before.cwd, before.cwd])
      if (before.sessionId && task?.target?.kind === 'session' && !sessionChoices.some(([id]) => id === before.sessionId)) sessionChoices.unshift([before.sessionId, before.sessionId])
      dialog.innerHTML = `<form method="dialog">
        <h2 id="host-schedule-editor-title">${task ? tr('编辑自动化', 'Edit automation') : tr('新建自动化', 'New automation')}</h2>
        <label>${tr('名称', 'Name')}<input name="title" maxlength="120" required value="${esc(before.title)}"></label>
        <label>${tr('任务内容', 'Instructions')}<textarea name="prompt" rows="4" required>${esc(before.prompt)}</textarea></label>
        <label>${tr('触发规则', 'Trigger rule')}<select name="kind">${options(Object.entries({ ...(!Object.hasOwn(kinds, before.kind) ? { [before.kind]: [before.kind, before.kind] } : {}), ...kinds }).map(([kind, label]) => [kind, tr(...label)]), before.kind)}</select></label>
        <label><span data-timing-label></span><textarea name="timingValue" rows="2">${esc(before.timingValue)}</textarea></label>
        <label data-zone>${tr('时区（IANA）', 'IANA time zone')}<input name="zone" value="${esc(before.zone)}" placeholder="Asia/Shanghai"></label>
        <label data-weekdays>${tr('星期（1=周一，7=周日）', 'Weekdays (1 Mon, 7 Sun)')}<input name="weekdays" value="${esc(before.weekdays)}" placeholder="1,3,5"></label>
        <small>${tr('时间由主机校验。夏令时切换时，一次性任务可用显式 UTC 偏移消除歧义；重复规则按所选时区或 RRULE 的 TZID 执行。', 'The Host validates times. For a one-time trigger during a DST change, use an explicit UTC offset. Recurrences use the selected zone or the RRULE TZID.')}</small>
        <label>${tr('投递至', 'Deliver to')}<select name="destination">${options(Object.entries(destinations).map(([kind, label]) => [kind, tr(...label)]), before.destination)}</select></label>
        <label data-session>${tr('现有会话', 'Existing session')}<select name="sessionId">${options([['', tr('选择会话', 'Choose a session')], ...sessionChoices], before.sessionId)}</select></label>
        <label data-workspace>${tr('工作区', 'Workspace')}<select name="cwd">${options([['', tr('主机默认工作区', 'Host default workspace')], ...workspaceChoices], before.cwd)}</select></label>
        <p data-editor-status role="status"></p><div class="host-state-actions"><button value="cancel" formnovalidate>${tr('取消', 'Cancel')}</button><button value="save">${tr('保存到主机', 'Save to Host')}</button></div>
      </form>`
      const editor = dialog.querySelector('form'), fields = editor.elements, status = editor.querySelector('[data-editor-status]')
      const update = () => {
        const kind = fields.kind.value
        editor.querySelector('[data-zone]').hidden = !['at', 'daily', 'weekly', 'cron'].includes(kind)
        editor.querySelector('[data-weekdays]').hidden = kind !== 'weekly'
        editor.querySelector('[data-session]').hidden = fields.destination.value !== 'session'
        editor.querySelector('[data-workspace]').hidden = fields.destination.value === 'session'
        editor.querySelector('[data-timing-label]').textContent = ({ at: tr('时间（本地日期时间或带偏移的 RFC 3339）', 'Date and time (local or RFC 3339 with offset)'), after: tr('延迟秒数', 'Delay in seconds'), every: tr('间隔秒数', 'Interval in seconds'), cron: tr('五字段 Cron 表达式', 'Five-field Cron expression'), rrule: 'DTSTART + RRULE' })[kind] || tr('本地时间（时:分）', 'Local time (HH:mm)')
      }
      editor.onchange = update; update()
      const baseline = Object.fromEntries(new root.FormData(editor))
      editor.onsubmit = async event => {
        if (event.submitter?.value !== 'save') return
        event.preventDefault()
        if (!valid(entry) || writing) return
        try {
          const patch = changes(Object.fromEntries(new root.FormData(editor)), baseline, task)
          if (!Object.keys(patch).length) { dialog.close(); return }
          event.submitter.disabled = true
          const saved = task ? await write('schedule.edit', { id: task.id, action: 'update', expectedUpdatedAt: task.updatedAt ?? null, patch }, task) : await write('schedule.create', patch)
          if (!valid(entry) || !dialog.open || editor !== dialog.querySelector('form')) return
          if (saved) dialog.close()
          else { status.textContent = feedback; event.submitter.disabled = !writable || !loaded }
        } catch (err) { status.textContent = explain(err) }
      }
      dialog.showModal()
    }

    function render() {
      if (!active()) return
      const panel = box(), disabled = loading || !writable || !loaded || !!writing
      const btn = (action, label, locked = false) => `<button type="button" data-auto="${action}" ${locked ? 'disabled' : ''}>${esc(label)}</button>`
      const current = history
      const historyHtml = current ? `<section class="host-state-card" aria-label="${tr('投递历史', 'Delivery history')}"><div class="host-state-actions"><h2>${tr('投递历史', 'Delivery history')} · ${esc(current.task.title)}</h2>${btn('history-close', tr('关闭', 'Close'))}</div>
        <small>${tr('投递只代表主机写入会话收件箱。执行结果按消息 ID 匹配对应轮次；未找到证据时不判定结果。', 'Delivery only confirms a Host inbox write. Execution is matched by message ID to its turn and stays unverified without evidence.')}</small>
        ${current.error ? `<p role="alert">${esc(current.error)}</p>` : ''}${current.partial ? `<p>${tr('更早的记录已被清理或不可用。', 'Earlier records were pruned or are unavailable.')}</p>` : ''}
        ${current.records.map(record => {
          const status = current.execution.get(record.messageId)
          return `<article class="host-state-card" data-delivery="${esc(record.messageId)}"><strong>${status === 'checking' ? tr('已投递 · 核对执行中', 'Delivered · checking execution') : tr(...(executionLabels[status] || executionLabels.unverified))}</strong><p>${tr('计划', 'Scheduled')}：${esc(formatTime(record.scheduledAt))}<br>${tr('已投递', 'Delivered')}：${esc(formatTime(record.deliveredAt))}</p>
            ${typeof record.prompt === 'string' ? `<details><summary>${tr('查看当次任务内容', 'View delivered instructions')}</summary><div class="host-state-pre">${esc(record.prompt)}</div></details>` : ''}
            <div class="host-state-actions">${btn('execution', tr('核对执行状态', 'Check execution'), status === 'checking')}${btn('session', tr('打开会话', 'Open session'), !record.targetSessionId)}</div></article>`
        }).join('')}
        ${!current.busy && !current.records.length && !current.error ? `<p>${tr('没有已保存的投递记录。', 'No saved deliveries.')}</p>` : ''}${current.busy ? `<p role="status">${tr('正在读取历史…', 'Loading history…')}</p>` : ''}${current.next ? btn('history-more', tr('加载更早记录', 'Load earlier records'), current.busy) : ''}</section>` : ''
      panel.innerHTML = `<div class="host-schedule"><div class="host-state-actions"><h1>${tr('自动化', 'Automations')}</h1>${btn('refresh', tr('刷新主机', 'Refresh Host'), loading || !!writing)}${btn('create', tr('新建任务', 'New task'), disabled)}</div>
        <p>${tr('这些任务由 DSH 主机调度。关闭 Remote 不会停止调度；DSH 主机必须保持运行。', 'DSH schedules these tasks. Closing Remote does not stop scheduling; the DSH Host must remain running.')}</p>
        ${!writable && loaded ? `<p>${tr('此设备仅可查看，不能变更任务。', 'This device can view but not change tasks.')}</p>` : ''}
        ${feedback ? `<p role="status">${esc(feedback)}</p>` : ''}${error ? `<p role="alert">${esc(error)}</p>` : ''}${loading ? `<p role="status">${tr('正在读取主机…', 'Reading Host state…')}</p>` : ''}
        ${historyHtml}
        ${loaded && !rows.length ? `<p>${tr('主机没有自动化任务。', 'The Host has no automation tasks.')}</p>` : ''}
        ${rows.map(task => `<article class="host-state-card" data-task="${esc(task.id)}"><h2>${esc(task.title)}</h2><p>${esc(taskLabel(task))} · ${esc(tr(...(kinds[task.kind] || [task.kind, task.kind])))}${task.status === 'active' ? ` · ${esc(formatTime(task.scheduledAt, task.timeZone))}` : ''}</p>
          <details><summary>${tr('任务内容与目标', 'Instructions and target')}</summary><div class="host-state-pre">${esc(task.prompt)}</div><p>${esc(tr(...(destinations[task.target?.kind] || ['目标未知', 'Unknown target'])))} · ${esc(task.target?.create?.cwd || config.sessions().find(session => session.id === task.target?.sessionId)?.label || task.target?.sessionId || tr('主机默认工作区', 'Host default workspace'))}</p></details>
          <div class="host-state-actions">${btn('history', tr('投递历史', 'Delivery history'), !loaded)}${btn('edit', tr('编辑', 'Edit'), disabled)}${btn('run', tr('立即运行', 'Run now'), disabled || task.executionActive === true)}${task.status === 'active' || task.status === 'paused' ? btn('toggle', task.status === 'active' ? tr('暂停', 'Pause') : tr('恢复', 'Resume'), disabled) : ''}${btn('delete', tr('删除', 'Delete'), disabled)}</div></article>`).join('')}
        <div class="host-state-actions">${offset ? btn('prev', tr('上一页', 'Previous'), loading || !!writing) : ''}${offset + rows.length < total ? btn('next', tr('下一页', 'Next'), loading || !!writing) : ''}</div></div>`
      panel.onclick = event => {
        const trigger = event.target.closest('[data-auto]')
        if (!trigger || trigger.disabled) return
        const action = trigger.dataset.auto
        if (action === 'refresh') return void refresh(true)
        if (action === 'create') return form()
        if (action === 'prev' || action === 'next') { offset += action === 'prev' ? -limit : limit; return void refresh() }
        if (action === 'history-close') { history = null; return render() }
        if (action === 'history-more' && current?.next) return void readHistory(current.task, current.next)
        if (action === 'execution' || action === 'session') {
          const record = current?.records.find(item => item.messageId === trigger.closest('[data-delivery]')?.dataset.delivery)
          if (!record) return
          if (action === 'execution') return void checkExecution(record)
          return void config.openSession(record.targetSessionId)
        }
        const task = rows.find(item => item.id === trigger.closest('[data-task]')?.dataset.task)
        if (!task) return
        if (action === 'history') return void readHistory(task)
        if (action === 'edit') return form(task)
        if (action === 'run') return void write('schedule.run', { id: task.id }, task)
        const expectedUpdatedAt = task.updatedAt ?? null
        if (action === 'toggle') return void write('schedule.edit', { id: task.id, action: 'update', patch: { active: task.status === 'paused' }, expectedUpdatedAt }, task)
        if (action === 'delete' && root.confirm(tr('删除任务和它的已保存投递记录？已投递的消息不会删除。', 'Delete the task and saved delivery history? Already delivered messages will remain.'))) return void write('schedule.edit', { id: task.id, action: 'delete', expectedUpdatedAt }, task)
      }
    }
    return { refresh, leave() { read++; dialog?.close(); connection = undefined; loading = false } }
  }

  const api = { create, timing, initial, changes }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.DshHostSchedule = api
})(globalThis)
