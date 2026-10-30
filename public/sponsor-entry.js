/* Reveal the trial application entry only after the cloud operator enables it. */
;(function () {
  'use strict'
  const origin = 'https://relay-pilot.blankalwaysgoeson.site'
  let busy = false, ready = false
  document.addEventListener('click', async event => {
    if (!event.target.closest?.('#btn-donate,#btn-donate-about,[data-donate-open]') || busy || ready) return
    busy = true
    try {
      const response = await fetch(origin + '/sponsor/api/config', { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(5000) })
      if (!response.ok || (await response.json()).enabled !== true) return
      for (const body of document.querySelectorAll('.donate-body')) {
        const line = document.createElement('p'), link = document.createElement('a')
        link.textContent = window.I18N?.lang === 'en' ? 'Basic relay trial · Sponsor ¥1 or more for one month' : '基础中转试运营申请 · 单次赞助 ¥1 及以上开通一个月'
        link.href = origin + '/sponsor/'; link.target = '_blank'; link.rel = 'noopener noreferrer'
        line.append(link); body.append(line)
      }
      ready = true
    } catch { /* Optional trial entry; ordinary sponsorship remains available. */ }
    finally { busy = false }
  })
})()
