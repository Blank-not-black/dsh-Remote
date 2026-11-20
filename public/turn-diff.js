/* Optional per-turn deliverables, Host-recorded changed files and per-file diffs.
 *
 * The feature is off by default. While it is off this module renders no card and
 * issues no request at all. When it is on, each card is built from durable Host
 * events only:
 *   - `deliverables/presented` (the `present` tool: { turn, callId, files })
 *   - `workspace/changes` (the Host recorder appended one per top-level turn)
 * The changed-file list and every comparison are read from the authenticated
 * Host routes served by @deepseek-ai/dsh-client-ui-deliverables:
 *   GET /api/changes.summary?sessionId=&seq=
 *   GET /api/changes.diff?sessionId=&seq=&index=
 * The comparison is the Host's turn-start/turn-end snapshot. This module never
 * reads or substitutes the current file, and it reports `missing`, `binary` and
 * `oversized` explicitly because the Host keeps these summaries only while the
 * Session lives (a Host restart removes them). Original attachment delivery is
 * untouched: deliveries are rendered as new cards and never replace or intercept
 * the existing attachment/download UI.
 *
 * Adapter contract:
 *   state.sessionId() -> string|null
 *   state.entries(sessionId) -> Array<{ seq, event }>
 *   fetchJson(path, query) -> Promise<{ ok:boolean, status:number, data:any }>
 *     Authenticated GET through the Remote gateway (`apiUrl` + Bearer token).
 *   dom.root -> Element
 *   layout -> 'mobile' | 'desktop' | (() => 'mobile' | 'desktop')
 *   enabled? -> boolean                 // optional persisted switch seed; default false
 *   onOpenFile({ sessionId, turn, path, description }) -> void   // optional
 *   notify(message, kind) -> void       // optional
 */
'use strict'
;(function (root) {
  const text = (zh, en) => (root.I18N?.lang === 'en' ? en : zh)
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const SUMMARY_PATH = '/api/changes.summary'
  const DIFF_PATH = '/api/changes.diff'
  const MAX_RENDER_LINES = 2000
  const MAX_PATH = 400

  const KIND_LABELS = {
    added: () => text('新增', 'Added'),
    deleted: () => text('删除', 'Deleted'),
    modified: () => text('修改', 'Modified'),
    binary: () => text('二进制', 'Binary'),
    oversized: () => text('超大', 'Too large'),
    unavailable: () => text('不可用', 'Unavailable'),
    changed: () => text('有改动', 'Changed'),
  }
  function kindLabel(kind) { return (KIND_LABELS[kind] || KIND_LABELS.changed)() }

  function numberOrNull(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  function safeArray(value) { return Array.isArray(value) ? value : [] }
  function cleanPath(value) { return typeof value === 'string' ? value.trim().slice(0, MAX_PATH) : '' }
  function basename(value) {
    const path = String(value || '')
    const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    return at === -1 ? path : path.slice(at + 1)
  }
  function clip(value, max) {
    const body = String(value ?? '')
    return body.length > max ? body.slice(0, max) + '…' : body
  }

  /* ------------------------------------------------------------------ switch */

  /** Only an explicit `true` enables the feature; everything else stays off. */
  function normalizeEnabled(value) {
    return value === true || value === 'true' || value === 1
  }

  /* -------------------------------------------------------------- event fold */

  function presentedFiles(data) {
    if (!data || typeof data !== 'object') return null
    if (!Number.isSafeInteger(data.turn) || data.turn < 1) return null
    if (typeof data.callId !== 'string' || !data.callId) return null
    if (!Array.isArray(data.files)) return null
    const files = []
    data.files.forEach((file, index) => {
      if (!file || typeof file !== 'object') return
      const path = cleanPath(file.path)
      if (!path) return
      files.push({
        index,
        path,
        name: basename(path),
        description: typeof file.description === 'string' ? clip(file.description, 400) : '',
      })
    })
    return { turn: data.turn, callId: data.callId.slice(0, 200), files }
  }

  function changesOfEvent(event) {
    if (!event || event.type !== 'workspace/changes') return null
    const data = event.data || {}
    if (!Number.isSafeInteger(data.turn) || data.turn < 1) return null
    return { turn: data.turn }
  }

  /**
   * Fold Session log entries into ordered per-turn cards. Only the last
   * `workspace/changes` announcement of a turn is kept (it is the latest record);
   * deliveries from every `present` call accumulate and de-duplicate by call.
   */
  function turnsFromEntries(entries) {
    const rows = safeArray(entries).filter(entry => entry && entry.event && typeof entry.event === 'object')
    const sorted = rows.slice().sort((a, b) => (numberOrNull(a.seq) ?? 0) - (numberOrNull(b.seq) ?? 0))
    const seen = new Set()
    const byTurn = new Map()
    const deliveryKeys = new Set()
    for (const entry of sorted) {
      if (Number.isSafeInteger(entry.seq)) {
        if (seen.has(entry.seq)) continue
        seen.add(entry.seq)
      }
      const event = entry.event
      const seq = Number.isSafeInteger(entry.seq) ? entry.seq : null
      const delivered = presentedFiles(event.data)
      if (delivered) {
        const row = byTurn.get(delivered.turn) || { turn: delivered.turn, firstSeq: seq ?? 0, lastSeq: seq ?? 0, deliveries: [], changes: null }
        for (const file of delivered.files) {
          const key = delivered.callId + ':' + file.index + ':' + file.path
          if (deliveryKeys.has(key)) continue
          deliveryKeys.add(key)
          row.deliveries.push({ ...file, seq, callId: delivered.callId })
        }
        row.lastSeq = Math.max(row.lastSeq, seq ?? 0)
        byTurn.set(delivered.turn, row)
        continue
      }
      const changes = changesOfEvent(event)
      if (changes) {
        const row = byTurn.get(changes.turn) || { turn: changes.turn, firstSeq: seq ?? 0, lastSeq: seq ?? 0, deliveries: [], changes: null }
        if (!row.changes || (seq ?? 0) >= (row.changes.seq ?? 0)) row.changes = { seq }
        row.lastSeq = Math.max(row.lastSeq, seq ?? 0)
        byTurn.set(changes.turn, row)
      }
    }
    return Array.from(byTurn.values()).sort((a, b) => a.turn - b.turn)
  }

  /* ------------------------------------------------------------ summary model */

  function summaryModel(summary) {
    if (!summary || typeof summary !== 'object' || !Array.isArray(summary.files)) return null
    const files = summary.files.map((file, index) => {
      const path = cleanPath(file?.path)
      const display = cleanPath(file?.display) || path
      if (!path) return null
      const binary = file?.binary === true
      const oversized = file?.oversized === true
      return {
        index,
        path,
        display,
        added: typeof file?.added === 'number' && file.added >= 0 ? file.added : 0,
        deleted: typeof file?.deleted === 'number' && file.deleted >= 0 ? file.deleted : 0,
        binary,
        oversized,
        status: binary ? 'binary' : oversized ? 'oversized' : 'changed',
      }
    }).filter(Boolean)
    return {
      turn: Number.isSafeInteger(summary.turn) ? summary.turn : null,
      files,
      total: Number.isSafeInteger(summary.total) && summary.total >= 0 ? summary.total : files.length,
      added: typeof summary.added === 'number' && summary.added >= 0 ? summary.added : files.reduce((sum, file) => sum + file.added, 0),
      deleted: typeof summary.deleted === 'number' && summary.deleted >= 0 ? summary.deleted : files.reduce((sum, file) => sum + file.deleted, 0),
    }
  }

  /* -------------------------------------------------------------- diff model */

  /** The Host-reported state of one file: added / deleted / modified / binary / oversized. */
  function fileKind(file, diffState) {
    const data = diffState?.data
    if (file?.binary || data?.kind === 'binary' || diffState?.status === 'binary') return 'binary'
    if (file?.oversized || data?.kind === 'oversized' || diffState?.status === 'oversized') return 'oversized'
    if (!diffState || diffState.status !== 'ready' || !data) return 'changed'
    if (data.kind !== 'text') return 'unavailable'
    const before = data.before !== false
    const after = data.after !== false
    if (!before && !after) return 'unavailable'
    if (!before) return 'added'
    if (!after) return 'deleted'
    return 'modified'
  }

  function validHunks(hunks) {
    if (!Array.isArray(hunks)) return null
    const out = []
    for (const hunk of hunks) {
      if (!hunk || typeof hunk !== 'object' || !Array.isArray(hunk.lines)) return null
      const lines = hunk.lines.filter(line => typeof line === 'string')
      out.push({
        oldStart: numberOrNull(hunk.oldStart) ?? 1,
        oldLines: numberOrNull(hunk.oldLines) ?? 0,
        newStart: numberOrNull(hunk.newStart) ?? 1,
        newLines: numberOrNull(hunk.newLines) ?? 0,
        lines,
      })
    }
    return out
  }

  /** Unified rows from the Host comparison hunks. */
  function splitHunks(diff) {
    const hunks = validHunks(diff?.hunks) || []
    const rows = []
    for (const hunk of hunks) {
      rows.push({ kind: 'hunk', text: '@@ -' + hunk.oldStart + ',' + hunk.oldLines + ' +' + hunk.newStart + ',' + hunk.newLines + ' @@' })
      let oldNo = hunk.oldStart
      let newNo = hunk.newStart
      for (const line of hunk.lines) {
        const sign = line[0]
        const body = line.slice(1)
        if (sign === '+') { rows.push({ kind: 'add', oldNo: null, newNo, text: body }); newNo++ }
        else if (sign === '-') { rows.push({ kind: 'remove', oldNo, newNo: null, text: body }); oldNo++ }
        else { rows.push({ kind: 'context', oldNo, newNo, text: body }); oldNo++; newNo++ }
      }
    }
    return rows
  }

  /** Paired old/new rows for the desktop side-by-side view. */
  function sideBySideRows(diff) {
    const hunks = validHunks(diff?.hunks) || []
    const rows = []
    for (const hunk of hunks) {
      rows.push({ kind: 'hunk', text: '@@ -' + hunk.oldStart + ',' + hunk.oldLines + ' +' + hunk.newStart + ',' + hunk.newLines + ' @@' })
      let oldNo = hunk.oldStart
      let newNo = hunk.newStart
      let removed = []
      let added = []
      const flush = () => {
        const length = Math.max(removed.length, added.length)
        for (let i = 0; i < length; i++) {
          rows.push({ kind: 'pair', old: removed[i] || null, new: added[i] || null })
        }
        removed = []
        added = []
      }
      for (const line of hunk.lines) {
        const sign = line[0]
        const body = line.slice(1)
        if (sign === '+') { added.push({ no: newNo, text: body }); newNo++ }
        else if (sign === '-') { removed.push({ no: oldNo, text: body }); oldNo++ }
        else { flush(); rows.push({ kind: 'pair', old: { no: oldNo, text: body }, new: { no: newNo, text: body }, context: true }); oldNo++; newNo++ }
      }
      flush()
    }
    return rows
  }

  function lineCount(diff) {
    return splitHunks(diff).filter(row => row.kind !== 'hunk').length
  }
  function onlyAddsOrRemoves(diff) {
    const rows = splitHunks(diff).filter(row => row.kind !== 'hunk')
    if (!rows.length) return false
    return rows.every(row => row.kind === 'add') || rows.every(row => row.kind === 'remove')
  }

  /** Keep whole hunk headers and at most `max` changed/context lines. */
  function capRows(rows, max) {
    const out = []
    let count = 0
    for (const row of rows) {
      if (row.kind !== 'hunk') {
        if (count >= max) break
        count++
      }
      out.push(row)
    }
    return out
  }

  function unifiedLinesHtml(rows) {
    return rows.map(row => {
      if (row.kind === 'hunk') return `<div class="dr-diff-hunk">${esc(row.text)}</div>`
      const cls = row.kind === 'add' ? 'dr-diff-line--add' : row.kind === 'remove' ? 'dr-diff-line--remove' : 'dr-diff-line--context'
      const sign = row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '
      return `<div class="dr-diff-line ${cls}"><span class="dr-diff-no">${row.oldNo ?? ''}</span><span class="dr-diff-no">${row.newNo ?? ''}</span><span class="dr-diff-sign">${sign}</span><span class="dr-diff-code-text">${esc(row.text)}</span></div>`
    }).join('')
  }

  function splitLinesHtml(rows) {
    return rows.map(row => {
      if (row.kind === 'hunk') return `<div class="dr-diff-hunk">${esc(row.text)}</div>`
      const oldCls = row.old ? (row.context ? 'dr-diff-line--context' : 'dr-diff-line--remove') : 'dr-diff-line--blank'
      const newCls = row.new ? (row.context ? 'dr-diff-line--context' : 'dr-diff-line--add') : 'dr-diff-line--blank'
      return `<div class="dr-diff-row">
        <span class="dr-diff-cell dr-diff-cell--old ${oldCls}"><span class="dr-diff-no">${row.old ? row.old.no : ''}</span><span class="dr-diff-code-text">${row.old ? esc(row.old.text) : ''}</span></span>
        <span class="dr-diff-cell dr-diff-cell--new ${newCls}"><span class="dr-diff-no">${row.new ? row.new.no : ''}</span><span class="dr-diff-code-text">${row.new ? esc(row.new.text) : ''}</span></span>
      </div>`
    }).join('')
  }

  function messageHtml(kind, message, retry) {
    return `<p class="dr-diff-message dr-diff-message--${esc(kind)}" data-dr-diff-message="${esc(kind)}">${esc(message)}${retry ? ' <button type="button" class="dr-diff-retry" data-dr-diff-action="retry-diff">' + esc(text('重试', 'Retry')) + '</button>' : ''}</p>`
  }

  /**
   * Render one comparison. `layout` selects the mobile unified view or the
   * desktop side-by-side view; only additions or only deletions stay in one
   * column because a paired column would be empty.
   */
  function diffHtml(diffState, file, layout) {
    if (!diffState || diffState.status === 'loading') return `<p class="dr-diff-hint dr-diff-loading">${esc(text('正在读取主机对比…', 'Reading the Host comparison…'))}</p>`
    if (diffState.status === 'missing') return messageHtml('missing', text('主机已不再提供该文件的对比（Host 重启后不保存历史对比），不会用当前文件冒充历史内容。', 'The Host no longer serves this comparison (it keeps none across a restart); the current file is never substituted.'), true)
    if (diffState.status === 'error') return messageHtml('error', text('读取主机对比失败。', 'Reading the Host comparison failed.'), true)
    if (diffState.status === 'mismatch') return messageHtml('mismatch', text('主机返回的对比与所选文件不一致，已拒绝显示。', 'The Host returned a comparison for a different file, so it was refused.'), true)
    if (diffState.status === 'binary') return messageHtml('binary', text('二进制文件，主机不提供逐行对比。', 'Binary file — the Host serves no line comparison.'))
    if (diffState.status === 'oversized') return messageHtml('oversized', text('文件超过主机单文件上限，主机不提供对比。', 'The file exceeds the Host per-file limit, so no comparison is available.'))
    const data = diffState.data
    if (!data || data.kind !== 'text') return messageHtml('missing', text('主机没有提供可用的文本对比。', 'The Host supplied no usable text comparison.'))
    const kind = fileKind(file, diffState)
    const rows = splitHunks(data)
    const bodyRows = rows.filter(row => row.kind !== 'hunk')
    const head = `<div class="dr-diff-pane-head"><span class="dr-diff-file-kind dr-diff-file-kind--${esc(kind)}">${esc(kindLabel(kind))}</span><span class="dr-diff-pane-path" title="${esc(file?.path || '')}">${esc(file?.display || file?.path || '')}</span><span class="dr-diff-pane-counts">+${file?.added ?? 0} −${file?.deleted ?? 0}</span>${data.coarse ? `<span class="dr-diff-coarse">${esc(text('主机对比超时，按整文件替换显示', 'The Host comparison timed out; shown as full replacement'))}</span>` : ''}</div>`
    if (!bodyRows.length) return `<div class="dr-diff-pane dr-diff-pane--text" data-dr-diff-pane>${head}${messageHtml('same', text('该文件在本回合没有行级差异。', 'No line-level difference was recorded for this file.'))}</div>`
    const limited = bodyRows.length > MAX_RENDER_LINES
    const shown = limited ? capRows(rows, MAX_RENDER_LINES) : rows
    const split = layout === 'desktop' && !onlyAddsOrRemoves(data)
    const body = split
      ? `<div class="dr-diff-code dr-diff-code--split">${splitLinesHtml(sideBySideRows(data))}</div>`
      : `<div class="dr-diff-code dr-diff-code--unified">${unifiedLinesHtml(shown)}</div>`
    return `<div class="dr-diff-pane dr-diff-pane--text" data-dr-diff-pane>${head}${body}${limited ? `<p class="dr-diff-hint">${esc(text('对比行数过多，已截断显示。', 'The comparison is too long and was truncated.'))}</p>` : ''}</div>`
  }

  /* ------------------------------------------------------------------ markup */

  function summaryNotice(turn, summary) {
    if (!turn.changes) return ''
    const state = summary || { status: 'idle' }
    if (state.status === 'idle' || state.status === 'loading') return `<p class="dr-diff-hint dr-diff-loading">${esc(text('正在读取主机改动…', 'Reading the Host changes…'))}</p>`
    if (state.status === 'missing') return `<p class="dr-diff-message dr-diff-message--missing" data-dr-diff-message="summary-missing">${esc(text('主机已不再提供该回合改动（Host 重启后不保证存在），不会用当前文件冒充。', 'The Host no longer serves this turn\'s changes (it keeps none across a restart); the current file is never substituted.'))}</p>`
    if (state.status === 'error') return `<p class="dr-diff-message dr-diff-message--error" data-dr-diff-message="summary-error">${esc(text('读取主机改动失败。', 'Reading the Host changes failed.'))} <button type="button" class="dr-diff-retry" data-dr-diff-action="retry-summary">${esc(text('重试', 'Retry'))}</button></p>`
    if (state.status === 'empty') return `<p class="dr-diff-hint">${esc(text('本回合没有改动文件。', 'This turn changed no file.'))}</p>`
    return ''
  }

  function deliveriesHtml(turn) {
    if (!turn.deliveries.length) return ''
    return `<div class="dr-diff-deliveries" data-dr-diff-deliveries aria-label="${esc(text('主机交付物', 'Host deliverables'))}">
      ${turn.deliveries.map((file, index) => `<button type="button" class="dr-diff-delivery" data-dr-diff-action="delivery" data-dr-diff-turn="${turn.turn}" data-dr-diff-delivery="${index}" title="${esc(file.path)}">
        <span class="dr-diff-delivery-name">${esc(file.name)}</span>
        ${file.description ? `<span class="dr-diff-delivery-desc">${esc(file.description)}</span>` : ''}
      </button>`).join('')}
    </div>`
  }

  function filesHtml(turn, summary, selected, diffs) {
    const files = summary?.model?.files || []
    if (!files.length) return ''
    return `<div class="dr-diff-files" role="tablist" aria-label="${esc(text('改动文件', 'Changed files'))}">
      ${files.map(file => {
        const kind = fileKind(file, diffs[file.index])
        const active = file.index === selected
        return `<button type="button" role="tab" aria-selected="${active}" class="dr-diff-file${active ? ' is-selected' : ''} dr-diff-file--${esc(kind)}" data-dr-diff-action="file" data-dr-diff-turn="${turn.turn}" data-dr-diff-file="${file.index}">
          <span class="dr-diff-file-name" title="${esc(file.path)}">${esc(file.display)}</span>
          <span class="dr-diff-file-kind dr-diff-file-kind--${esc(kind)}">${esc(kindLabel(kind))}</span>
          <span class="dr-diff-file-counts">+${file.added} −${file.deleted}</span>
        </button>`
      }).join('')}
    </div>`
  }

  function paneHtml(turn, summary, selected, diffs, layout) {
    const files = summary?.model?.files || []
    const file = files.find(row => row.index === selected)
    if (!file) return ''
    return `<div class="dr-diff-pane-host" data-dr-diff-pane-host>${diffHtml(diffs[selected] || { status: 'loading' }, file, layout)}</div>`
  }

  function turnHtml(turn, view) {
    const summary = turn.summary
    const ready = summary?.status === 'ready'
    const selected = Number.isSafeInteger(turn.selected) ? turn.selected : 0
    const diffs = turn.diffs || {}
    const stats = ready && summary.model
      ? `<span class="dr-diff-turn-stat">${esc(text('改动 ', 'Changed ') + summary.model.total + text(' 个文件', ' files'))}</span><span class="dr-diff-turn-counts">+${summary.model.added} −${summary.model.deleted}</span>`
      : ''
    const deliveries = turn.deliveries.length ? `<span class="dr-diff-turn-stat">${esc(text('交付物 ', 'Deliverables ') + turn.deliveries.length)}</span>` : ''
    const body = `<div class="dr-diff-turn-body">
      ${deliveriesHtml(turn)}
      ${summaryNotice(turn, summary)}
      ${ready ? filesHtml(turn, summary, selected, diffs) : ''}
      ${ready && turn.expanded ? paneHtml(turn, summary, selected, diffs, view.layout) : ''}
    </div>`
    return `<section class="dr-diff-turn${turn.expanded ? ' is-expanded' : ' is-collapsed'}" data-dr-diff-turn="${turn.turn}">
      <header class="dr-diff-turn-head">
        <button type="button" class="dr-diff-toggle" data-dr-diff-action="toggle" data-dr-diff-turn="${turn.turn}" aria-expanded="${turn.expanded ? 'true' : 'false'}">
          <span class="dr-diff-chevron" aria-hidden="true">▸</span><span>${esc(text('回合 ', 'Turn ') + turn.turn)}</span>
        </button>
        <span class="dr-diff-turn-meta">${deliveries}${stats}</span>
      </header>
      ${body}
    </section>`
  }

  function viewHtml(view) {
    if (!view || view.enabled !== true) return ''
    const turns = safeArray(view.turns)
    if (!turns.length) return ''
    const layoutClass = view.layout === 'desktop' ? ' dr-diff-layout-desktop' : ' dr-diff-layout-mobile'
    return `<div class="dr-diff${layoutClass}" data-dr-diff-root>${turns.map(turn => turnHtml(turn, view)).join('')}</div>`
  }

  /* --------------------------------------------------------------- controller */

  function create(adapter) {
    const api = adapter && typeof adapter === 'object' ? adapter : {}
    const stateApi = api.state && typeof api.state === 'object' ? api.state : {}
    let sessionId = typeof stateApi.sessionId === 'function' ? stateApi.sessionId() : (stateApi.sessionId || null)
    let rootEl = api.dom?.root || null
    let unbind = null
    let disposed = false
    let enabled = normalizeEnabled(typeof api.enabled === 'function' ? api.enabled() : api.enabled)
    let layout = typeof api.layout === 'function' ? api.layout() : api.layout
    const summaries = new Map()
    const diffs = new Map()
    const expanded = new Set()
    const selected = new Map()
    const liveEvents = new Map()
    let sessionSynced = false

    function currentLayout() { return layout === 'desktop' ? 'desktop' : 'mobile' }
    function summaryKey(seq) { return String(sessionId || '') + ':' + String(seq) }
    function diffKey(seq, index) { return summaryKey(seq) + ':' + String(index) }
    function getEntries(id) {
      const base = typeof stateApi.entries === 'function' ? safeArray(stateApi.entries(id)) : []
      const live = liveEvents.get(String(id)) || []
      if (!live.length) return base
      const seen = new Set(base.map(entry => entry?.seq))
      return base.concat(live.filter(entry => entry && !seen.has(entry.seq))).sort((a, b) => (numberOrNull(a.seq) ?? 0) - (numberOrNull(b.seq) ?? 0))
    }
    function findTurn(turnNumber) {
      return turnsFromEntries(getEntries(sessionId)).find(turn => turn.turn === Number(turnNumber)) || null
    }

    function buildView() {
      const turns = turnsFromEntries(getEntries(sessionId))
      return {
        enabled,
        sessionId,
        layout: currentLayout(),
        turns: turns.map(turn => {
          const key = summaryKey(turn.changes?.seq)
          const summary = turn.changes ? (summaries.get(key) || { status: 'idle' }) : { status: 'none' }
          const selectedIndex = selected.get(turn.turn) ?? 0
          const rowDiffs = {}
          if (summary.status === 'ready') {
            for (const file of summary.model.files) {
              const cached = diffs.get(diffKey(turn.changes.seq, file.index))
              if (cached) rowDiffs[file.index] = cached
            }
          }
          return {
            turn: turn.turn,
            deliveries: turn.deliveries,
            changes: turn.changes,
            summary,
            expanded: expanded.has(turn.turn),
            selected: selectedIndex,
            diffs: rowDiffs,
          }
        }),
      }
    }
    function render(container) {
      if (container && typeof container === 'object') {
        if (rootEl && rootEl !== container) { if (unbind) unbind(); unbind = null }
        rootEl = container
      }
      const view = buildView()
      if (rootEl && typeof rootEl === 'object' && 'innerHTML' in rootEl) {
        rootEl.innerHTML = viewHtml(view)
        if (!unbind) unbind = bind(rootEl, controller)
      }
      // The Host summary/diff routes answer asynchronously. Clients that render
      // this module inside their own transcript slots get those slots updated once
      // the answer lands, without a second host render pass.
      repaintSlots()
      return view
    }
    function repaintSlots() {
      if (disposed || !enabled) return
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
      let slots
      try { slots = document.querySelectorAll('.dr-diff-turn-slot[data-turn]') } catch { return }
      if (!slots || !slots.length) return
      const full = buildView()
      for (const slot of slots) {
        const turnNumber = Number(slot?.dataset?.turn ?? slot?.getAttribute?.('data-turn'))
        if (!Number.isSafeInteger(turnNumber)) continue
        const turns = full.turns.filter(turn => turn.turn === turnNumber)
        const markup = turns.length ? viewHtml({ ...full, turns }) : ''
        if (slot.innerHTML !== markup) slot.innerHTML = markup
      }
    }

    function loadSummary(turn, force) {
      if (!turn.changes) return Promise.resolve({ status: 'none' })
      const key = summaryKey(turn.changes.seq)
      const cached = summaries.get(key)
      if (!force && cached && cached.status !== 'error') return cached.promise || Promise.resolve(cached)
      if (cached?.promise && cached.status === 'loading') return cached.promise
      const state = { status: 'loading' }
      summaries.set(key, state)
      render()
      state.promise = (async () => {
        try {
          const result = await api.fetchJson(SUMMARY_PATH, { sessionId, seq: turn.changes.seq })
          if (disposed) return summaries.get(key)
          if (!result || result.ok !== true) {
            const next = result && result.status === 404 ? { status: 'missing' } : { status: 'error', statusCode: result?.status || 0 }
            summaries.set(key, next)
            return next
          }
          const model = summaryModel(result.data)
          const next = model ? (model.files.length ? { status: 'ready', model } : { status: 'empty', model }) : { status: 'error', statusCode: 0 }
          summaries.set(key, next)
          return next
        } catch (error) {
          if (disposed) return summaries.get(key)
          const next = { status: 'error', error: String(error?.message || error) }
          summaries.set(key, next)
          return next
        } finally {
          if (!disposed && enabled) render()
        }
      })()
      return state.promise
    }

    function loadDiff(turn, file, force) {
      if (!turn.changes || !file) return Promise.resolve({ status: 'missing' })
      if (file.binary) { diffs.set(diffKey(turn.changes.seq, file.index), { status: 'binary' }); return Promise.resolve(diffs.get(diffKey(turn.changes.seq, file.index))) }
      if (file.oversized) { diffs.set(diffKey(turn.changes.seq, file.index), { status: 'oversized' }); return Promise.resolve(diffs.get(diffKey(turn.changes.seq, file.index))) }
      const key = diffKey(turn.changes.seq, file.index)
      const cached = diffs.get(key)
      if (!force && cached && cached.status !== 'error') return cached.promise || Promise.resolve(cached)
      if (cached?.promise && cached.status === 'loading') return cached.promise
      const state = { status: 'loading' }
      diffs.set(key, state)
      render()
      state.promise = (async () => {
        try {
          const result = await api.fetchJson(DIFF_PATH, { sessionId, seq: turn.changes.seq, index: file.index })
          if (disposed) return diffs.get(key)
          if (!result || result.ok !== true) {
            const next = result && result.status === 404 ? { status: 'missing' } : { status: 'error', statusCode: result?.status || 0 }
            diffs.set(key, next)
            return next
          }
          const data = result.data
          if (!data || typeof data !== 'object') {
            const next = { status: 'error' }
            diffs.set(key, next)
            return next
          }
          if (typeof data.path === 'string' && data.path && file.path && data.path !== file.path) {
            const next = { status: 'mismatch' }
            diffs.set(key, next)
            return next
          }
          let next
          if (data.kind === 'binary') next = { status: 'binary' }
          else if (data.kind === 'oversized') next = { status: 'oversized' }
          else if (data.kind === 'text' && validHunks(data.hunks)) next = { status: 'ready', data: { ...data, hunks: validHunks(data.hunks) } }
          else next = { status: 'error' }
          diffs.set(key, next)
          return next
        } catch (error) {
          if (disposed) return diffs.get(key)
          const next = { status: 'error', error: String(error?.message || error) }
          diffs.set(key, next)
          return next
        } finally {
          if (!disposed && enabled) render()
        }
      })()
      return state.promise
    }

    function ensureSummaryThenDiff(turn) {
      return loadSummary(turn, false).then(summary => {
        if (disposed || !enabled) return summary
        if (summary.status !== 'ready' || !summary.model.files.length) return summary
        const index = selected.get(turn.turn) ?? 0
        const file = summary.model.files.find(row => row.index === index) || summary.model.files[0]
        selected.set(turn.turn, file.index)
        render()
        return loadDiff(turn, file, false).then(() => summary)
      })
    }

    function refresh() {
      if (disposed) return Promise.resolve(buildView())
      if (!enabled) { render(); return Promise.resolve(buildView()) }
      if (sessionId) sessionSynced = true
      const turns = turnsFromEntries(getEntries(sessionId))
      const loads = []
      for (const turn of turns) {
        if (turn.changes) loads.push(loadSummary(turn, false))
      }
      render()
      return Promise.all(loads).then(() => { if (!disposed && enabled) render(); return buildView() })
    }

    const controller = {
      get session() { return sessionId },
      isEnabled() { return enabled },
      setEnabled(next) {
        const value = normalizeEnabled(next)
        if (value === enabled) return enabled
        enabled = value
        if (!enabled) {
          render()
          return enabled
        }
        sessionSynced = false
        void refresh()
        return enabled
      },
      setLayout(next) {
        layout = next === 'desktop' ? 'desktop' : 'mobile'
        render()
        return layout
      },
      view: buildView,
      refresh,
      render,
      setSession(next) {
        const id = next === null || next === undefined || next === '' ? null : String(next)
        const changed = id !== sessionId
        if (changed) sessionSynced = false
        sessionId = id
        render()
        if ((changed || !sessionSynced) && enabled && id) {
          sessionSynced = true
          void refresh()
        }
        return sessionId
      },
      handleEvent(eventSessionId, event) {
        if (disposed || !event || typeof event !== 'object') return false
        if (!enabled) return false
        const kind = event.type
        if (kind !== 'deliverables/presented' && kind !== 'workspace/changes') return false
        const id = String(eventSessionId || sessionId || '')
        if (!id) return false
        const live = liveEvents.get(id) || []
        if (!live.some(entry => entry.seq === event.seq)) live.push({ seq: event.seq, event })
        liveEvents.set(id, live)
        if (kind === 'workspace/changes') void refresh()
        else render()
        return true
      },
      toggleTurn(turnNumber) {
        if (!enabled) return Promise.resolve({ ok: false, error: text('功能未开启', 'The feature is off') })
        const turn = findTurn(turnNumber)
        if (!turn) return Promise.resolve({ ok: false, error: text('回合不存在', 'Unknown turn') })
        if (expanded.has(turn.turn)) {
          expanded.delete(turn.turn)
          render()
          return Promise.resolve({ ok: true, expanded: false })
        }
        expanded.add(turn.turn)
        render()
        return ensureSummaryThenDiff(turn).then(() => {
          render()
          return { ok: true, expanded: true }
        })
      },
      selectFile(turnNumber, index) {
        if (!enabled) return Promise.resolve({ ok: false, error: text('功能未开启', 'The feature is off') })
        const turn = findTurn(turnNumber)
        const target = Number(index)
        if (!turn || !Number.isInteger(target) || target < 0) return Promise.resolve({ ok: false, error: text('文件不存在', 'Unknown file') })
        expanded.add(turn.turn)
        selected.set(turn.turn, target)
        render()
        return loadSummary(turn, false).then(summary => {
          if (summary.status !== 'ready') { render(); return { ok: false, error: text('主机改动不可用', 'The Host changes are unavailable') } }
          const file = summary.model.files.find(row => row.index === target)
          if (!file) { render(); return { ok: false, error: text('文件不存在', 'Unknown file') } }
          return loadDiff(turn, file, false).then(() => {
            render()
            return { ok: true, index: target }
          })
        })
      },
      retrySummary(turnNumber) {
        const turn = findTurn(turnNumber)
        if (!turn || !turn.changes) return Promise.resolve({ ok: false })
        expanded.add(turn.turn)
        return loadSummary(turn, true).then(() => { render(); return { ok: true } })
      },
      retryDiff(turnNumber, index) {
        const turn = findTurn(turnNumber)
        if (!turn) return Promise.resolve({ ok: false })
        return loadSummary(turn, false).then(summary => {
          if (summary.status !== 'ready') { render(); return { ok: false } }
          const file = summary.model.files.find(row => row.index === Number(index))
          if (!file) return { ok: false }
          return loadDiff(turn, file, true).then(() => { render(); return { ok: true } })
        })
      },
      openDelivery(turnNumber, deliveryIndex) {
        const turn = findTurn(turnNumber)
        const file = turn?.deliveries?.[Number(deliveryIndex)]
        if (!file) return false
        if (typeof api.onOpenFile === 'function') {
          api.onOpenFile({ sessionId, turn: turn.turn, path: file.path, description: file.description })
        }
        return true
      },
      hasPendingRequest() {
        return Array.from(summaries.values()).some(state => state.status === 'loading') || Array.from(diffs.values()).some(state => state.status === 'loading')
      },
      dispose() {
        disposed = true
        if (unbind) unbind()
        unbind = null
        summaries.clear()
        diffs.clear()
        expanded.clear()
        selected.clear()
        liveEvents.clear()
      },
    }
    if (rootEl) render()
    return controller
  }

  /* ------------------------------------------------------------------ binding */

  function bind(container, controller) {
    if (!container || typeof container.addEventListener !== 'function') return () => {}
    if (container.dataset && container.dataset.drDiffBound === '1') return () => {}
    if (container.dataset) container.dataset.drDiffBound = '1'
    const onClick = event => {
      const target = event?.target
      const button = target && typeof target.closest === 'function' ? target.closest('[data-dr-diff-action]') : null
      if (!button || button.disabled === true) return
      const action = button.dataset?.drDiffAction || button.getAttribute?.('data-dr-diff-action') || ''
      const turn = Number(button.dataset?.drDiffTurn ?? button.getAttribute?.('data-dr-diff-turn'))
      const index = Number(button.dataset?.drDiffFile ?? button.getAttribute?.('data-dr-diff-file'))
      const delivery = Number(button.dataset?.drDiffDelivery ?? button.getAttribute?.('data-dr-diff-delivery'))
      const run = {
        toggle: () => controller.toggleTurn(turn),
        file: () => controller.selectFile(turn, index),
        delivery: () => controller.openDelivery(turn, delivery),
        'retry-summary': () => controller.retrySummary(turn),
        'retry-diff': () => controller.retryDiff(turn, index),
      }[action]
      if (!run) return
      Promise.resolve(run()).catch(() => {})
    }
    container.addEventListener('click', onClick)
    return () => {
      container.removeEventListener?.('click', onClick)
      if (container.dataset) delete container.dataset.drDiffBound
    }
  }

  const api = {
    SUMMARY_PATH, DIFF_PATH, MAX_RENDER_LINES,
    normalizeEnabled, turnsFromEntries, presentedFiles, summaryModel,
    fileKind, splitHunks, sideBySideRows, onlyAddsOrRemoves, diffHtml, viewHtml,
    create, init: create, bind, esc, basename, kindLabel,
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.DshTurnDiff = api
})(typeof window === 'undefined' ? globalThis : window)
