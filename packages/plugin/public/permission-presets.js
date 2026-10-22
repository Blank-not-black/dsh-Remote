/* Host-provided permission presets (sandbox mode + approval policy). No guessed list. */
'use strict'
;(function (root) {
  const CACHE_MS = 15000
  const MAX_OPTIONS = 20
  const VALUE = /^[a-z][a-z0-9-]{0,63}$/
  // Used only when the host cannot answer, so pre-0.2.1 servers keep the three
  // sandbox modes this client switched between before presets were configurable.
  const FALLBACK = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])
  // Presets that run without a sandbox need an explicit risk acknowledgement.
  const GATED = new Set(['auto', 'danger-full-access'])
  // `custom` is derived host state: it may be shown as current, never switched to.
  const UNSELECTABLE = new Set(['custom'])
  let cached = null

  const text = (tag, className, value) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (value != null) node.textContent = value
    return node
  }
  const button = (className, value) => {
    const node = document.createElement('button')
    node.type = 'button'
    node.className = className
    if (value != null) node.textContent = value
    return node
  }

  function rowsOf(payload) {
    if (!Array.isArray(payload?.options)) return null
    const rows = [], seen = new Set()
    for (const item of payload.options) {
      const value = typeof item?.value === 'string' ? item.value.trim() : ''
      if (!value || !VALUE.test(value) || UNSELECTABLE.has(value) || seen.has(value)) continue
      seen.add(value)
      const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 80) : value
      const description = typeof item.description === 'string' ? item.description.trim().slice(0, 400) : ''
      rows.push({ value, name, description })
      if (rows.length >= MAX_OPTIONS) break
    }
    return rows
  }

  const fallbackRows = () => FALLBACK.map(value => ({ value, name: value, description: '' }))
  const identity = connection => String(connection?.server || '') + '\u0000' + String(connection?.token || '')

  async function load({ rpc, connection }) {
    const key = identity(connection)
    if (cached && cached.key === key && Date.now() - cached.at < CACHE_MS) return cached.value
    let rows = null
    try { rows = rowsOf(await rpc('permissionPresets.catalog', {}, 10000)) } catch { rows = null }
    const value = rows && rows.length ? { known: true, rows } : { known: false, rows: fallbackRows() }
    if (connection?.valid?.() !== false) cached = { key, at: Date.now(), value }
    return value
  }

  function invalidate() { cached = null }

  function labelOf(row, t) {
    // The host reports the Auto contribution by its machine name; the shipped
    // client owns that option's label, badge and description.
    return row.value === 'auto' ? t('perm.autoLabel') : row.name
  }

  function detailOf(row, t) {
    return row.value === 'auto' ? t('perm.autoDesc') : row.description
  }

  function chip(row, isCurrent, options) {
    const { t } = options
    const node = button('menu-chip perm-opt' + (isCurrent ? ' current' : '') + (GATED.has(row.value) ? ' danger' : ''))
    node.dataset.perm = row.value
    node.setAttribute('aria-pressed', isCurrent ? 'true' : 'false')
    node.append(document.createTextNode(labelOf(row, t)))
    if (row.value === 'auto') node.append(text('span', 'perm-badge', t('perm.autoBadge')))
    const detail = detailOf(row, t)
    if (detail) node.title = detail
    node.addEventListener('click', () => {
      if (!valid(options)) return
      if (isCurrent) { options.close?.(); return }
      if (GATED.has(row.value)) confirm(row, options)
      else void apply(row.value, options)
    })
    return node
  }

  function currentOnly(value, options) {
    const node = button('menu-chip perm-opt current', value + ' · ' + options.t('perm.current'))
    node.disabled = true
    return node
  }

  function confirm(row, options) {
    const { container, t } = options
    const auto = row.value === 'auto'
    const card = text('div', 'perm-confirm')
    const acknowledge = document.createElement('input')
    acknowledge.type = 'checkbox'
    acknowledge.className = 'perm-confirm-box'
    const ackLabel = text('label', 'perm-confirm-ack')
    ackLabel.append(acknowledge, text('span', null, t(auto ? 'perm.autoConfirmAck' : 'perm.confirmAck')))
    const actions = text('div', 'perm-confirm-actions')
    const cancel = button('menu-chip perm-confirm-cancel', t('perm.confirmCancel'))
    const enable = button('menu-chip danger perm-confirm-enable', t(auto ? 'perm.autoConfirmEnable' : 'perm.confirmEnable'))
    enable.disabled = true
    acknowledge.addEventListener('change', () => { enable.disabled = !acknowledge.checked })
    cancel.addEventListener('click', () => { container.__dshPerm = (container.__dshPerm || 0) + 1; void open(options) })
    enable.addEventListener('click', () => { if (acknowledge.checked) void apply(row.value, options) })
    actions.append(cancel, enable)
    card.append(
      text('div', 'perm-confirm-title', t(auto ? 'perm.autoConfirmTitle' : 'perm.confirmTitle')),
      text('p', 'perm-confirm-desc', t(auto ? 'perm.autoConfirmDesc' : 'perm.confirmDesc')),
      ackLabel,
      actions,
    )
    container.replaceChildren(card)
  }

  async function apply(value, options) {
    const { container, t } = options
    if (!valid(options) || container.dataset.pending) return
    const operation = {}; container.__dshPermPending = operation
    container.dataset.pending = value
    let ok = false
    try { ok = await options.request(value) } catch { ok = false }
    if (container.__dshPermPending === operation) delete container.dataset.pending
    if (!valid(options)) return
    if (!ok) { options.toast?.(t('perm.changeFailed'), 'err'); return }
    options.close?.()
  }

  async function open(options) {
    const { container, t } = options
    if (!container) return
    const serial = container.__dshPerm = (container.__dshPerm || 0) + 1
    delete container.dataset.pending
    container.__dshPermPending = null
    options = { ...options, serial }
    container.replaceChildren(text('div', 'perm-hint', t('perm.loading')))
    const result = await load(options)
    if (!valid(options)) return
    container.replaceChildren()
    const current = typeof options.current === 'string' ? options.current : ''
    for (const row of result.rows) container.append(chip(row, row.value === current, options))
    if (current && !result.rows.some(row => row.value === current)) container.append(currentOnly(current, options))
    if (!result.known) container.append(text('div', 'perm-hint', t('perm.hostUnavailable')))
  }

  function valid(options) {
    return options.container.__dshPerm === options.serial && options.connection?.valid?.() !== false && options.currentValid?.() !== false
  }

  root.DshPermissionPresets = {
    open, invalidate, rowsOf, fallbackRows,
    gated: value => GATED.has(value),
    fallback: FALLBACK.slice(),
  }
})(window)
