// Only public peak-pricing settings are projected; account configuration stays on the host.
export function peakReminderSchedule(config, now = Date.now()) {
  const base = { ok: true, schema: 1, source: 'dsh-cost-meter', generatedAt: now, validUntil: now + 7 * 86400000 }
  if (config?.peakEnabled === false || config?.peakAlertEnabled === false) return { ...base, available: true, enabled: false, events: [] }
  const windows = config?.peakWindows, holidays = config?.peakHolidays
  const effectiveAt = Date.parse(config?.peakEffectiveAt || '')
  const validDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0,10) === d
  const ahead = config?.peakAlertAhead ?? 2, target = config?.peakAlertTarget ?? 'both'
  if (config?.peakEnabled !== true || !Array.isArray(windows) || windows.length > 24 || !Array.isArray(holidays) || holidays.length > 366
      || !Number.isFinite(effectiveAt) || !Number.isInteger(ahead) || ahead < 1 || ahead > 30 || !['peak','offpeak','both'].includes(target)
      || windows.some(w => !Number.isInteger(w?.start) || w.start < 0 || w.start > 23 || !Number.isInteger(w?.end) || w.end < 0 || w.end > 24)
      || holidays.some(d => !validDate(d))) {
    return { ...base, available: false, code: 'unsupported-policy', events: [] }
  }
  const excluded = new Set(holidays)
  const isPeak = at => {
    if (at < effectiveAt) return false
    const beijing = new Date(at + 8 * 3600000), day = beijing.getUTCDay()
    if (day === 0 || day === 6 || excluded.has(beijing.toISOString().slice(0,10))) return false
    const hour = new Date(at).getUTCHours()
    return windows.some(w => w.start < w.end ? hour >= w.start && hour < w.end : hour >= w.start || hour < w.end)
  }
  const candidates = new Set([effectiveAt]), midnight = Math.floor(now / 86400000) * 86400000
  for (let day = -1; day <= 8; day++) {
    const start = midnight + day * 86400000
    candidates.add(start + 16 * 3600000)
    for (const w of windows) { candidates.add(start + w.start * 3600000); candidates.add(start + w.end * 3600000) }
  }
  const transitions = [...candidates].sort((a,b) => a-b).flatMap(at => {
    const intoPeak = isPeak(at)
    if (at < now - 30 * 60000 || at > base.validUntil || isPeak(at - 1) === intoPeak) return []
    return [{ id: at + ':' + (intoPeak ? 'peak' : 'offpeak'), at, notifyAt: at - ahead * 60000, intoPeak }]
  })
  const events = transitions.filter(e => target === 'both' || (target === 'peak') === e.intoPeak).slice(0,64)
  // Status needs every boundary even when alerts target only peak or offpeak.
  const phase = { intoPeak: isPeak(now), transitions: transitions.filter(e => e.at > now).map(({ at, intoPeak }) => ({ at, intoPeak })) }
  return { ...base, available: true, enabled: true, aheadMinutes: ahead, target, timezone: 'Asia/Shanghai', phase, events }
}

export async function readPeakReminders(ctx) {
  let service
  try { service = ctx.get?.('costMeter') } catch {}
  if (!service || typeof service.getState !== 'function') return { status: 200, body: { ok: true, schema: 1, available: false, code: 'not-installed' } }
  let timer
  try {
    const state = await Promise.race([Promise.resolve().then(() => service.getState()), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 20000) })])
    return { status: 200, body: peakReminderSchedule(state?.config) }
  } catch { return { status: 502, body: { ok: false, code: 'peak-policy-unavailable' } } }
  finally { clearTimeout(timer) }
}
