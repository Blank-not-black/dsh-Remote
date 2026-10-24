/* Read-only taskBoard service adapter, pinned to the published schema 6. */
const text = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : ''
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x20]/.test(value) ? value : ''
const statuses = new Set(['backlog','todo','running','done','failed'])
export function summarizeTaskBoard(raw, workspace) {
  if (raw?.schemaVersion !== 6 || !Array.isArray(raw.tasks) || raw.tasks.length > 10000 || !Number.isSafeInteger(raw.revision) || raw.revision < 0) throw Error('unsupported')
  const members = new Set(workspace.sessionIds || [])
  const matching = raw.tasks.filter(task => task && task.workspaceId === workspace.id && task.hidden !== true)
    .sort((a,b) => Number(number(a.archivedAt) > 0) - Number(number(b.archivedAt) > 0)
      || Number(b.status === 'running') - Number(a.status === 'running') || (number(b.updatedAt) || 0) - (number(a.updatedAt) || 0))
  const taskIds = new Set(matching.map(task => task.id))
  const seen = new Set()
  const tasks = matching.slice(0, 200).map(task => {
    if (!id(task.id) || seen.has(task.id) || !statuses.has(task.status) || !Array.isArray(task.executions)) throw Error('unsupported')
    seen.add(task.id)
    const executions = task.executions.slice(-3).map(value => {
      const run = record(value), verification = record(run.verification), attempts = Array.isArray(verification.attempts) ? verification.attempts : []
      const attempt = record(attempts.at(-1))
      return { id: text(run.id), sessionId: run.external !== true && members.has(run.sessionId) ? id(run.sessionId) : '', external: run.external === true,
        startedAt: number(run.startedAt), endedAt: number(run.endedAt), result: ['succeeded','failed','cancelled'].includes(run.result) ? run.result : null,
        error: text(run.error, 1000), summary: text(run.summary?.text, 1000),
        verification: run.verification ? { applicability: text(verification.applicability, 40), inFlight: verification.inFlight === true,
          stage: text(attempt.stage, 40), passed: typeof attempt.passed === 'boolean' ? attempt.passed : null,
          failedReason: text(verification.failedReason, 1000) } : null }
    })
    const schedule = record(task.schedule)
    return { id: task.id, title: text(task.title, 300), description: text(task.description, 1500), status: task.status,
      parentId: taskIds.has(task.parentId) ? text(task.parentId) : '',
      updatedAt: number(task.updatedAt), archivedAt: number(task.archivedAt), executions,
      schedule: task.schedule ? { enabled: schedule.enabled === true, mode: ['cron','once'].includes(schedule.mode) ? schedule.mode : 'unknown',
        cron: text(schedule.cron, 100), timeZone: text(schedule.timeZone || raw.scheduler?.timeZone, 100),
        nextRunAt: number(schedule.nextRunAt), at: number(schedule.at), runCount: number(schedule.runCount) } : null }
  })
  return { ok: true, schema: 1, available: true, source: 'task-board', workspaceId: workspace.id, revision: raw.revision,
    generatedAt: Date.now(), timeZone: text(raw.scheduler?.timeZone, 100), truncated: matching.length > 200,
    tasks }
}
export async function readTaskBoard(ctx, query, timeoutMs = 20000) {
  if ([...query.keys()].some(key => key !== 'workspaceId') || query.getAll('workspaceId').length !== 1 || !id(query.get('workspaceId'))) return { status: 400, body: { ok: false, code: 'invalid-query' } }
  let timer
  try {
    const registry = ctx.get?.('workspaceRegistry') ?? ctx.get?.('workspace')
    if (typeof registry?.list !== 'function') return { status: 503, body: { ok: false, code: 'workspace-unavailable' } }
    const workspaces = await registry.list(), workspace = Array.isArray(workspaces) && workspaces.find(row => row.id === query.get('workspaceId'))
    if (!workspace) return { status: 404, body: { ok: false, code: 'workspace-not-found' } }
    const service = ctx.get?.('taskBoard')
    if (!service) return { status: 200, body: { ok: true, schema: 1, available: false, code: 'not-installed' } }
    if (typeof service.snapshot !== 'function') return { status: 200, body: { ok: true, schema: 1, available: false, code: 'unsupported' } }
    const raw = await Promise.race([Promise.resolve().then(() => service.snapshot()), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), timeoutMs) })])
    return { status: 200, body: summarizeTaskBoard(raw, workspace) }
  } catch (error) {
    return { status: error.message === 'unsupported' ? 200 : 502, body: error.message === 'unsupported'
      ? { ok: true, schema: 1, available: false, code: 'unsupported' } : { ok: false, code: error.message === 'timeout' ? 'timeout' : 'task-board-unavailable' } }
  } finally { clearTimeout(timer) }
}
