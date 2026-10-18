/* Read-only AgentTeams projection, scoped by registered workspace membership. */
const text = (v, n = 500) => typeof v === 'string' ? v.slice(0, n) : ''
const list = (v, n = 300) => Array.isArray(v) ? v.slice(0, n) : []
const number = v => Number.isFinite(v) && v >= 0 ? v : null
export function summarizeTeams(raw, workspace) {
  if (!raw || !Array.isArray(raw.teams)) throw Error('unsupported')
  const members = new Set(workspace.sessionIds || [])
  const matching = raw.teams.filter(team => team && members.has(team.captainSessionId))
  return { ok: true, schema: 1, available: true, workspaceId: workspace.id, truncated: matching.length > 40,
    teams: matching.slice(0, 40).map(team => ({
      teamId: text(team.teamId, 120), name: text(team.name, 200), description: text(team.description, 2000),
      captainSessionId: text(team.captainSessionId, 200), phase: text(team.phase, 40), planReviewState: text(team.planReviewState, 60), halted: team.halted === true,
      deliverable: typeof team.deliverable === 'boolean' ? team.deliverable : null,
      delivery: team.delivery && typeof team.delivery.ok === 'boolean' ? { ok: team.delivery.ok,
        blockers: list(team.delivery.blockers, 30).map(v => text(v)), warnings: list(team.delivery.warnings, 30).map(v => text(v)) } : null,
      membersTruncated: Array.isArray(team.members) && team.members.length > 100,
      members: list(team.members, 100).map(member => ({ id: text(member?.id, 200), name: text(member?.name, 120), role: text(member?.role),
        provider: text(member?.provider, 100), model: text(member?.model, 120), status: text(member?.status, 60), activity: text(member?.activity, 40),
        done: number(member?.done), total: number(member?.total), currentTask: text(member?.currentTask, 120), unread: number(member?.unread) })),
      tasksTruncated: Array.isArray(team.tasks) && team.tasks.length > 300,
      tasks: list(team.tasks).map(task => ({ id: text(task?.id, 120), subject: text(task?.subject), description: text(task?.description, 2000),
        status: text(task?.status, 40), state: text(task?.state, 40), assignee: text(task?.assignee, 120),
        dependencies: list(task?.dependencies, 100).map(v => text(v, 120)), verdictStale: text(task?.verdictStale), updatedAt: number(task?.updatedAt) })),
      messageCount: number(team.messageCount), captainInbox: list(team.captainInbox, 5).map(row => ({ from: text(row?.from, 120), content: text(row?.content, 2000) }))
    })) }
}
export async function readTeamInsights(ctx, query, fetchState) {
  if ([...query.keys()].some(key => !['workspaceId','archived'].includes(key)) || query.getAll('workspaceId').length !== 1 || query.getAll('archived').length > 1) return { status: 400, body: { ok: false, code: 'invalid-query' } }
  const id = query.get('workspaceId'), archived = query.get('archived') || '0'
  if (!id || id.length > 200 || /[\x00-\x1f]/.test(id) || !['0','1'].includes(archived)) return { status: 400, body: { ok: false, code: 'invalid-query' } }
  try {
    const registry = ctx.get?.('workspaceRegistry') ?? ctx.get?.('workspace')
    if (!registry || typeof registry.list !== 'function') return { status: 503, body: { ok: false, code: 'workspace-unavailable' } }
    const workspace = registry.list().find(row => row.id === id)
    if (!workspace) return { status: 404, body: { ok: false, code: 'workspace-not-found' } }
    // Upstream owns team assembly. Never scan client-supplied paths or forward controls.
    const response = await fetchState(archived === '1')
    if (response.status === 404) return { status: 200, body: { ok: true, schema: 1, available: false, code: 'not-installed' } }
    if (!response.ok) return { status: 502, body: { ok: false, code: 'teams-unavailable' } }
    const reader = response.body.getReader(), chunks = []
    let size = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 2 * 1024 * 1024) throw Error('too-large')
        chunks.push(Buffer.from(part.value))
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    return { status: 200, body: summarizeTeams(JSON.parse(Buffer.concat(chunks).toString('utf8')), workspace) }
  } catch { return { status: 502, body: { ok: false, code: 'teams-unavailable' } } }
}
