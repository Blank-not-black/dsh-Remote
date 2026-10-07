// Synthetic data shaped like dsh-context 0.64 and dsh-cost-meter 1.8.12.
const now = 1791334800000
const head = { ok: true, model: 'deepseek-v4.1-flash', provider: 'deepseek', contextWindow: 128000,
  current: { system: 2400, tools: 5800, user: 3600, inject: 900, skill: 1200, assistant: 12800, tool: 4600, total: 31300 },
  counts: { turns: 6, steps: 18, compactions: 2, prunes: 1, injects: 4 }, detailRev: 7 }
const detail = { rev: 7, head, events: [
  { seq: 4, kind: 'inject', name: '项目约定', time: now - 1800000, tokens: 900 },
  { seq: 16, kind: 'compaction', time: now - 600000, tokens: 14000 },
  { seq: 18, kind: 'prune', time: now - 180000, tokens: 3200 },
], requests: [], nodes: [], archive: [], droppedNodes: 0 }
const state = { today: { date: '2026-10-07', cost: 1.45, apiCost: .72, calls: 28 },
  config: { apiKey: 'TEST-SECRET-DO-NOT-FORWARD', customBalance: { request: { url: 'https://private.invalid', headers: { authorization: 'SECRET' } } },
    goQuota: { enabled: true, display: 'both' }, balance: { display: 'both' } },
  balance: { status: 'ok', currency: 'CNY', totalBalance: 83.25, fetchedAt: now },
  goQuota: { status: 'ok', fetchedAt: now, rolling: { percent: 38.5, resetsAt: '2026-10-07T15:00:00+08:00' }, weekly: { percent: 62, resetsAt: '2026-10-12T09:00:00+08:00' }, monthly: null },
  codingPlans: { anthropic: { enabled: true, display: 'both', status: 'ok', apiKey: 'TEST-SECRET-PLAN', fetchedAt: now,
    windows: { weekly: { percent: 24.5, resetsAt: '2026-10-12T00:00:00Z' } } } } }
const sessionCost = { found: true, own: { id: 'insights-session', cost: .52, apiCost: .18, calls: 18 },
  subagents: { cost: .12, apiCost: .04, calls: 3 }, subagentCount: 2 }
module.exports = { head, detail, state, sessionCost }
