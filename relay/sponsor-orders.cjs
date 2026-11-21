'use strict'
const { fault, reserved, SPONSOR_ORDER_WINDOW } = require('./registry.cjs')

const BEIJING_OFFSET = 8 * 3600000
const PRICE_CENTS = 500
const MONTHLY_STOCK = 20
const PACKS_PER_PERIOD = 2
const MAX_PERIODS = 3
const calendarDay = now => new Date(now + BEIJING_OFFSET).getUTCDate()
const stockMonth = now => new Date(now + BEIJING_OFFSET).toISOString().slice(0, 7)

function nextMonth(now, day = calendarDay(now)) {
  const date = new Date(now + BEIJING_OFFSET)
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + 1)
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(day, last))
  return date.getTime() - BEIJING_OFFSET
}

function periodsFor(grant) {
  if (!grant) return []
  if (grant.sponsorPeriods) return grant.sponsorPeriods
  if (!Number.isSafeInteger(grant.periodStartsAt)) return []
  const { periodStartsAt: startsAt, expiresAt } = grant
  const anchorDay = calendarDay(nextMonth(startsAt) === expiresAt ? startsAt : expiresAt)
  return [{ startsAt, expiresAt, anchorDay, packIds: [] }]
}

function orderFor(kind, packs, grant, now) {
  if (!Array.isArray(packs) || !packs.length || packs.length > MAX_PERIODS ||
      Array.from(packs).some(count => !Number.isInteger(count) || count < 0 || count > PACKS_PER_PERIOD)) {
    throw fault('INVALID_PACK_SELECTION')
  }
  const periods = periodsFor(grant)
  if (kind === 'packs') {
    const active = periods.find(p => p.startsAt <= now && now < p.expiresAt)
    if (packs.length !== 1 || packs[0] === 0) throw fault('INVALID_PACK_SELECTION')
    if (!active || now >= active.startsAt + SPONSOR_ORDER_WINDOW) throw fault('PACK_WINDOW_CLOSED', 409)
    if (active.packIds.length + packs[0] > PACKS_PER_PERIOD) throw fault('PACK_LIMIT_EXCEEDED', 409)
    return { kind, amountCents: PRICE_CENTS * packs[0], periods: [{ startsAt: active.startsAt, expiresAt: active.expiresAt, anchorDay: active.anchorDay, packs: packs[0] }] }
  }
  if (kind === 'open' && packs.length !== 1) throw fault('INVALID_SERVICE_TERM')
  if (periods.filter(period => period.expiresAt > now).length + packs.length > MAX_PERIODS) throw fault('PREPAID_TERM_LIMIT', 409)
  const latest = periods.at(-1)
  let startsAt = Math.max(now, latest?.expiresAt ?? now)
  const anchorDay = latest?.expiresAt === startsAt ? latest.anchorDay : calendarDay(startsAt)
  const scheduled = packs.map(count => {
    const expiresAt = nextMonth(startsAt, anchorDay)
    const period = { startsAt, expiresAt, anchorDay, packs: count }
    startsAt = expiresAt
    return period
  })
  return { kind, amountCents: PRICE_CENTS * packs.reduce((sum, count) => sum + 1 + count, 0), periods: scheduled }
}

function checkStock(applications, order, now, excludeId) {
  const required = new Map()
  for (const period of order.periods) {
    if (!period.packs) continue
    const month = stockMonth(period.startsAt)
    required.set(month, (required.get(month) || 0) + period.packs)
  }
  if (!required.size) return
  for (const row of applications) {
    if (row.id === excludeId || !row.order || row.status !== 'approved' && !reserved(row, now)) continue
    for (const period of row.order.periods) {
      const month = stockMonth(period.startsAt)
      if (required.has(month)) required.set(month, required.get(month) + period.packs)
    }
  }
  if ([...required.values()].some(count => count > MONTHLY_STOCK)) throw fault('PACK_STOCK_EXHAUSTED', 409)
}

function recordOrder(grant, order, id) {
  const periods = periodsFor(grant).slice()
  for (const [index, { startsAt, expiresAt, anchorDay, packs }] of order.periods.entries()) {
    const packIds = Array.from({ length: packs }, (_, pack) => `${id}:${index}:${pack}`)
    if (order.kind === 'packs') {
      const period = periods.find(period => period.startsAt === startsAt)
      if (!period) throw fault('PACK_WINDOW_CLOSED', 409)
      period.packIds = [...period.packIds, ...packIds]
    } else periods.push({ startsAt, expiresAt, anchorDay, orderId: id, packIds })
  }
  grant.sponsorPeriods = periods
  grant.expiresAt = periods.at(-1).expiresAt
}

module.exports = { PRICE_CENTS, MONTHLY_STOCK, nextMonth, orderFor, checkStock, recordOrder }
