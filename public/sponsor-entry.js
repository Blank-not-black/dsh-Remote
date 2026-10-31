/* Reveal the trial application entry only after the cloud operator enables it. */
;(function () {
  'use strict'
  const origin = 'https://relay-pilot.blankalwaysgoeson.site'
  let busy = false, lastRead = 0
  document.addEventListener('click', async event => {
    if (!event.target.closest?.('#btn-donate,#btn-donate-about,[data-donate-open]') || busy || Date.now() - lastRead < 30000) return
    busy = true
    try {
      const response = await fetch(origin + '/sponsor/api/config', { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(5000) })
      if (!response.ok) return
      const config = await response.json()
      for (const line of document.querySelectorAll('[data-sponsor-entry]')) line.remove()
      lastRead = Date.now()
      if (config.enabled !== true) return
      for (const body of document.querySelectorAll('.donate-body')) {
        const line = document.createElement('p'), link = document.createElement('a')
        line.dataset.sponsorEntry = 'true'
        const en = window.I18N?.lang === 'en'
        link.textContent = config.accepting === false ? (en ? 'Basic relay · Applications paused; check an existing application' : '基础中转 · 暂停新申请，可查询已有申请') : config.remaining === 0 ? (en ? 'Basic relay · Currently full; check an existing application' : '基础中转 · 名额已满，可查询已有申请') : (en ? 'Basic relay trial · Sponsor ¥1 or more for one month' : '基础中转试运营申请 · 单次赞助 ¥1 及以上开通一个月')
        link.href = origin + '/sponsor/'; link.target = '_blank'; link.rel = 'noopener noreferrer'
        line.append(link); body.append(line)
      }
    } catch { /* Optional trial entry; ordinary sponsorship remains available. */ }
    finally { busy = false }
  })
})()
