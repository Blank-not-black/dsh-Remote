// Read-only, bounded adapter for dsh-cost-meter 1.8.x. Never forward its config.
const states = new WeakMap()
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const text = (value, max = 80) => typeof value === 'string' ? value.slice(0, max) : ''
const status = value => ['ok', 'off', 'error', 'stale', 'loading', 'partial'].includes(value) ? value : 'unknown'
const visible = value => value?.enabled === true && value.display !== 'off'
const unit = value => ['USD', 'CNY', 'EUR', 'CREDITS'].includes(value) ? value : ''
function customBalances(raw, config) {
  const multiple = Array.isArray(config.customBalances)
  const definitions = multiple ? config.customBalances : [config.customBalance]
  const snapshots = multiple ? (Array.isArray(raw.customBalances) ? raw.customBalances : []) : [raw.customBalance]
  return snapshots.slice(0, 40).flatMap(value => {
    const row = record(value), index = multiple ? row.index : 0
    if (!Number.isInteger(index) || index < 0 || !visible(definitions[index])) return []
    return [{ name: text(row.label || definitions[index].label), status: status(row.status), fetchedAt: number(row.fetchedAt),
      currency: unit(row.unit), remaining: typeof row.remaining === 'number' && Number.isFinite(row.remaining) ? row.remaining : null,
      maxBudget: number(row.maxBudget), spend: number(row.spend) }]
  })
}
function gatewayQuotas(raw, config) {
  const definitions = Array.isArray(config.gatewayQuotas?.sources) ? config.gatewayQuotas.sources : []
  return (Array.isArray(raw.gatewayQuotas) ? raw.gatewayQuotas : []).slice(0, 20).flatMap(value => {
    const row = record(value)
    if (!visible(definitions.find(source => source?.id === row.id))) return []
    return [{ name: text(row.label), status: status(row.status), fetchedAt: number(row.fetchedAt),
      accounts: (Array.isArray(row.accounts) ? row.accounts : []).slice(0, 16).map(value => {
        const account = record(value)
        return { name: text(account.label), provider: text(account.provider), status: status(account.status),
          windows: (Array.isArray(account.windows) ? account.windows : []).slice(0, 8).map(value => {
            const w = record(value), percent = number(w.percent)
            return { name: text(w.label || w.id), percent: percent !== null && percent <= 100 ? percent : null, resetsAt: text(w.resetsAt) }
          }) }
      }) }]
  })
}
function amount(value) {
  const row = record(value)
  const tokens = Object.fromEntries(['input', 'cacheRead', 'cacheWrite', 'output'].map(key => [key, number(row[key])]))
  const cost = number(row.cost), apiCost = number(row.apiCost)
  return { cost, apiCost, planEquivalent: cost !== null && apiCost !== null && cost >= apiCost ? cost - apiCost : null, calls: number(row.calls), tokens,
    totalTokens: Object.values(tokens).every(value => value !== null) ? Object.values(tokens).reduce((sum, value) => sum + value, 0) : null }
}
function windows(value, statistics) {
  return Object.entries(record(value)).slice(0, 8).map(([key, raw]) => {
    const row = record(raw), percent = number(row.percent)
    const stat = record(record(statistics)[key] || record(statistics)[{ rolling: 'fiveHour', five_hour: 'fiveHour', seven_day: 'weekly' }[key]])
    return { name: text(key), percent: percent !== null && percent <= 100 ? percent : null,
      resetsAt: text(row.resetsAt), unlimited: row.unlimited === true, localTokens: number(stat.localTokens) }
  })
}
export function summarizeCost(state, session, sessionId) {
  const raw = record(state), config = record(raw.config), balance = record(raw.balance)
  const plans = Object.entries(record(raw.codingPlans)).slice(0, 20)
    .filter(([, row]) => record(row).enabled === true && record(row).display !== 'off')
    .map(([name, value]) => {
      const row = record(value)
    return { name: text(name), status: status(row.status), fetchedAt: number(row.fetchedAt), windows: windows(row.windows, record(record(raw.planStats).providers)[name]?.windows) }
    })
  const go = record(raw.goQuota)
  if (record(config.goQuota).enabled === true && record(config.goQuota).display !== 'off') {
    plans.unshift({ name: 'OpenCode Go', status: status(go.status), fetchedAt: number(go.fetchedAt),
      windows: windows({ rolling: go.rolling, weekly: go.weekly, monthly: go.monthly }, record(record(raw.planStats).providers).go?.windows).filter(row => row.percent !== null) })
  }
  const s = record(session)
  return { schema: 1, available: true, source: 'dsh-cost-meter', generatedAt: Date.now(), currency: 'USD',
    day: text(record(raw.meta).dayKey || record(raw.runtime).dayKey || record(raw.today).date, 10),
    today: config.hideTodayCost === true ? null : amount(raw.today),
    history: config.hideTodayCost === true ? [] : (Array.isArray(raw.history) ? raw.history : []).slice(0, 90).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row?.date)).sort((a, b) => a.date.localeCompare(b.date)).slice(-7).map(row => ({ date: row.date, ...amount(row) })),
    session: sessionId ? { found: s.found === true, own: s.found === true ? amount(s.own) : null,
      subagents: s.found === true ? amount(s.subagents) : null, subagentCount: number(s.subagentCount) } : null,
    balance: config.hideOfficialBalance === true || record(config.balance).display === 'off' ? null : {
      status: status(balance.status), fetchedAt: number(balance.fetchedAt),
      currency: /^[A-Z]{3}$/.test(balance.currency) ? balance.currency : '', total: number(balance.totalBalance) }, plans,
    customBalances: customBalances(raw, config), gatewayQuotas: gatewayQuotas(raw, config) }
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
    // Independent reads share one wait window; serial 20s waits can exceed both
    // the gateway's 30s and the insights client's 25s request budgets.
    const [raw, session] = await Promise.all([cache.task || cache.value,
      sessionId && typeof service.getSessionCost === 'function'
        ? bounded(Promise.resolve().then(() => service.getSessionCost(sessionId))) : null])
    return { status: 200, body: { ok: true, ...summarizeCost(raw, session, sessionId) } }
  } catch {
    // Plugin failures may mention credentials, URLs or paths. Return a fixed code.
    return { status: 502, body: { ok: false, code: 'cost-unavailable' } }
  }
}
