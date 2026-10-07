// Read-only, bounded adapter for dsh-cost-meter 1.8.x. Never forward its config.
const states = new WeakMap()
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const text = (value, max = 80) => typeof value === 'string' ? value.slice(0, max) : ''
const status = value => ['ok', 'off', 'error', 'stale', 'loading'].includes(value) ? value : 'unknown'
function amount(value) {
  const row = record(value)
  return { cost: number(row.cost), apiCost: number(row.apiCost ?? row.cost), calls: number(row.calls) }
}
function windows(value) {
  return Object.entries(record(value)).slice(0, 8).map(([key, raw]) => {
    const row = record(raw), percent = number(row.percent)
    return { name: text(key), percent: percent !== null && percent <= 100 ? percent : null,
      resetsAt: text(row.resetsAt), unlimited: row.unlimited === true }
  })
}
export function summarizeCost(state, session, sessionId) {
  const raw = record(state), config = record(raw.config), balance = record(raw.balance)
  const plans = Object.entries(record(raw.codingPlans)).slice(0, 20)
    .filter(([, row]) => record(row).enabled === true && record(row).display !== 'off')
    .map(([name, value]) => {
      const row = record(value)
      return { name: text(name), status: status(row.status), fetchedAt: number(row.fetchedAt), windows: windows(row.windows) }
    })
  const go = record(raw.goQuota)
  if (record(config.goQuota).enabled === true && record(config.goQuota).display !== 'off') {
    plans.unshift({ name: 'OpenCode Go', status: status(go.status), fetchedAt: number(go.fetchedAt),
      windows: windows({ rolling: go.rolling, weekly: go.weekly, monthly: go.monthly }).filter(row => row.percent !== null) })
  }
  const s = record(session)
  return { schema: 1, available: true, source: 'dsh-cost-meter', generatedAt: Date.now(), currency: 'USD',
    day: text(record(raw.runtime).dayKey || record(raw.today).date, 10),
    today: config.hideTodayCost === true ? null : amount(raw.today),
    session: sessionId ? { found: s.found === true, own: s.found === true ? amount(s.own) : null,
      subagents: s.found === true ? amount(s.subagents) : null, subagentCount: number(s.subagentCount) } : null,
    balance: config.hideOfficialBalance === true || record(config.balance).display === 'off' ? null : {
      status: status(balance.status), fetchedAt: number(balance.fetchedAt),
      currency: /^[A-Z]{3}$/.test(balance.currency) ? balance.currency : '', total: number(balance.totalBalance) }, plans }
}
function bounded(task, ms = 20000) {
  let timer
  return Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms) })])
    .finally(() => clearTimeout(timer))
}
export async function readCostInsights(ctx, sessionId = '') {
  if (typeof sessionId !== 'string' || sessionId.length > 200 || /[\s\x00-\x1f\x7f]/.test(sessionId)) {
    return { status: 400, body: { ok: false, code: 'invalid-session' } }
  }
  let service
  try { service = ctx.get?.('costMeter') } catch {}
  if (!service) return { status: 200, body: { ok: true, schema: 1, available: false, code: 'not-installed' } }
  if (typeof service.getState !== 'function') return { status: 200, body: { ok: true, schema: 1, available: false, code: 'unsupported' } }
  try {
    // A short shared cache coalesces device reads; no credentials or settings are sent.
    let cache = states.get(ctx)
    const identity = service[Symbol.for('cordis.original')] ?? service
    if (!cache || cache.service !== identity) { cache = { service: identity, at: 0 }; states.set(ctx, cache) }
    if (!cache.task && (!cache.value || Date.now() - cache.at > 15000)) {
      cache.task = bounded(Promise.resolve().then(() => service.getState())).then(value => {
        if (!value || typeof value !== 'object' || !value.today) throw new Error('unsupported')
        cache.value = value; cache.at = Date.now(); return value
      }).finally(() => { cache.task = null })
    }
    const raw = cache.task ? await cache.task : cache.value
    const session = sessionId && typeof service.getSessionCost === 'function'
      ? await bounded(Promise.resolve().then(() => service.getSessionCost(sessionId))) : null
    return { status: 200, body: { ok: true, ...summarizeCost(raw, session, sessionId) } }
  } catch {
    // Plugin failures may mention credentials, URLs or paths. Return a fixed code.
    return { status: 502, body: { ok: false, code: 'cost-unavailable' } }
  }
}
