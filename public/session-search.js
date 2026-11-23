/* dsh-remote session search — host-backed full-text search, workspace filter and hit locating.
 *
 * Everything in this module is transport-agnostic: the Host call, the catalog and
 * navigation arrive through an explicit adapter (see init). The module never reads
 * app.js lexical state and never treats a local title/ID filter as content search.
 */
;(function (root) {
  'use strict'

  const STATUS = Object.freeze({
    IDLE: 'idle',
    LOADING: 'loading',
    RESULTS: 'results',
    EMPTY: 'empty',
    DENIED: 'denied',
    ERROR: 'error',
    UNSUPPORTED: 'unsupported',
  })

  /* Mirrored from @deepseek-ai/dsh-api-session-controller: the Host rejects a
   * longer query and truncates snippets to this many code points. */
  const MAX_QUERY_CHARS = 500
  const MAX_SNIPPET_CODE_POINTS = 240
  const HOST_RESULT_LIMIT = 20
  const UNGROUPED = '__ungrouped__'

  function isEnglish() { return !!root.I18N && root.I18N.lang === 'en' }
  function text(zh, en) { return isEnglish() ? en : zh }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))
  }

  function clipCodePoints(value, max = MAX_SNIPPET_CODE_POINTS) {
    const points = Array.from(String(value == null ? '' : value))
    return points.length <= max ? points.join('') : points.slice(0, max).join('') + '…'
  }

  /** Trim, reject blank/NUL/oversized queries exactly as the Host does. */
  function normalizeQuery(raw) {
    const value = String(raw == null ? '' : raw).trim()
    if (!value) return { ok: false, query: '', error: 'empty', message: text('请输入搜索关键词', 'Enter a search query') }
    if (value.includes('\0')) return { ok: false, query: '', error: 'nul', message: text('搜索关键词不能包含空字符', 'The query must not contain NUL') }
    if (value.length > MAX_QUERY_CHARS) {
      return { ok: false, query: '', error: 'too-long', message: text(`搜索关键词最多 ${MAX_QUERY_CHARS} 个字符`, `The query may contain at most ${MAX_QUERY_CHARS} characters`) }
    }
    return { ok: true, query: value, error: null, message: '' }
  }

  /** Cross-platform path key used only to resolve a session's workspace. */
  function pathKey(value) {
    let key = String(value == null ? '' : value).replace(/\\/g, '/').replace(/\/+/g, '/')
    if (key.length > 1) key = key.replace(/\/+$/, '')
    const windows = /^[A-Za-z]:\//.test(key) || String(value == null ? '' : value).includes('\\')
      || !!(root.navigator && /Windows/i.test(String(root.navigator.platform || root.navigator.userAgent || '')))
    return windows ? key.toLowerCase() : key
  }

  function baseName(value) {
    const clean = String(value == null ? '' : value).replace(/[\\/]+$/, '')
    return clean.split(/[\\/]/).pop() || clean
  }

  function normalizeWorkspace(row) {
    if (!row || typeof row !== 'object') return null
    const workspaceId = typeof row.workspaceId === 'string' ? row.workspaceId : ''
    if (!workspaceId) return null
    const path = typeof row.path === 'string' ? row.path : ''
    const title = typeof row.title === 'string' ? row.title.trim() : ''
    return {
      workspaceId,
      path,
      title,
      name: title || baseName(path) || path,
      sessionIds: Array.isArray(row.sessionIds) ? row.sessionIds.map(String) : [],
      raw: row,
    }
  }

  function sessionTitle(session, titleOf) {
    if (typeof titleOf === 'function') {
      try {
        const custom = titleOf(session)
        if (typeof custom === 'string' && custom.trim()) return custom.trim()
      } catch {}
    }
    const projected = session && session.projections && session.projections.values && session.projections.values.title
    if (typeof projected === 'string' && projected.trim()) return projected.trim()
    if (session && typeof session.title === 'string' && session.title.trim()) return session.title.trim()
    const id = session && session.sessionId ? String(session.sessionId) : ''
    return id ? text('未命名会话', 'Untitled conversation') + ' · ' + id.slice(-8) : text('未知会话', 'Unknown conversation')
  }

  function workspaceForSession(session, workspaces) {
    if (!session) return null
    const sessionId = String(session.sessionId || '')
    const explicit = typeof session.workspaceId === 'string' ? session.workspaceId : ''
    if (explicit) {
      const match = workspaces.find(workspace => workspace.workspaceId === explicit)
      if (match) return match
    }
    if (sessionId) {
      const member = workspaces.find(workspace => workspace.sessionIds.some(id => id === sessionId))
      if (member) return member
    }
    const cwdKey = pathKey(session.cwd)
    if (!cwdKey) return null
    for (const workspace of workspaces) {
      const workspaceKey = pathKey(workspace.path)
      if (!workspaceKey) continue
      if (cwdKey === workspaceKey || cwdKey.startsWith(workspaceKey.endsWith('/') ? workspaceKey : workspaceKey + '/')) return workspace
    }
    return null
  }

  /**
   * Fold Host session.list rows and workspace.list rows into one lookup.
   * `archivedSessionIds`/`pinnedSessionIds` are registry-global Host sets.
   */
  function normalizeCatalog(input = {}) {
    const rawSessions = Array.isArray(input.sessions) ? input.sessions : []
    const workspaces = (Array.isArray(input.workspaces) ? input.workspaces : []).map(normalizeWorkspace).filter(Boolean)
    const archivedIds = new Set((Array.isArray(input.archivedSessionIds) ? input.archivedSessionIds : []).map(String))
    const pinnedIds = new Set((Array.isArray(input.pinnedSessionIds) ? input.pinnedSessionIds : []).map(String))
    const byId = new Map()
    const sessions = []
    for (const raw of rawSessions) {
      if (!raw || typeof raw !== 'object' || !raw.sessionId) continue
      const sessionId = String(raw.sessionId)
      if (byId.has(sessionId)) continue
      const workspace = workspaceForSession(raw, workspaces)
      const entry = {
        sessionId,
        title: sessionTitle(raw, input.titleOf),
        cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
        workspaceId: workspace ? workspace.workspaceId : '',
        workspaceName: workspace ? workspace.name : '',
        workspacePath: workspace ? workspace.path : (typeof raw.cwd === 'string' ? raw.cwd : ''),
        archived: archivedIds.has(sessionId),
        pinned: pinnedIds.has(sessionId),
        origin: raw.origin,
        blank: raw.blank === true,
        raw,
      }
      sessions.push(entry)
      byId.set(sessionId, entry)
    }
    return { sessions, byId, workspaces, archivedIds, pinnedIds }
  }

  /** A session is visible in the normal list unless it is a subagent or a blank shell. */
  function isVisibleCatalogSession(entry) {
    return !!entry && entry.origin !== 'subagent' && !entry.blank
  }

  function metadataMatchKinds(entry, query) {
    const needle = String(query || '').toLowerCase()
    if (!needle) return []
    const kinds = []
    if (String(entry.title || '').toLowerCase().includes(needle)) kinds.push('title')
    if (String(entry.sessionId || '').toLowerCase().includes(needle)) kinds.push('sessionId')
    return kinds
  }

  function workspaceView(entry) {
    if (!entry || !entry.workspaceId) return null
    return {
      workspaceId: entry.workspaceId,
      name: entry.workspaceName,
      path: entry.workspacePath,
    }
  }

  function entryMatchesFilters(entry, { workspaceId = '', includeArchived = false } = {}) {
    if (!includeArchived && entry.archived) return false
    if (workspaceId) {
      if (workspaceId === UNGROUPED) return !entry.workspaceId
      if (entry.workspaceId !== workspaceId) return false
    }
    return true
  }

  function makeResult(entry, matchKinds, snippet, extra = {}) {
    return {
      sessionId: entry.sessionId,
      title: entry.title,
      workspace: workspaceView(entry),
      snippet: snippet || '',
      matchKinds,
      archived: entry.archived,
      pinned: entry.pinned,
      unresolved: !!entry.unresolved,
      ...extra,
    }
  }

  /**
   * Merge Host content hits with local title/session-ID matches.
   * Host hits are content matches and are always labelled as such; metadata
   * matches never pretend to be full-text hits.
   */
  function mergeSearchResults(input = {}) {
    const catalog = input.catalog || normalizeCatalog(input)
    const query = String(input.query || '').trim()
    const workspaceId = input.workspaceId || ''
    const includeArchived = input.includeArchived === true
    const hostItems = Array.isArray(input.hostItems) ? input.hostItems : []
    const order = []
    const merged = new Map()
    const stats = { contentHits: 0, metadataHits: 0, filteredArchived: 0, filteredWorkspace: 0, unresolved: 0, hostItems: hostItems.length }

    for (const hit of hostItems) {
      if (!hit || typeof hit !== 'object' || typeof hit.sessionId !== 'string' || !hit.sessionId) continue
      const sessionId = hit.sessionId
      const known = catalog.byId.get(sessionId)
      const isArchived = known ? known.archived : catalog.archivedIds.has(sessionId)
      if (!includeArchived && isArchived) { stats.filteredArchived++; continue }
      if (workspaceId && (!known || !entryMatchesFilters(known, { workspaceId, includeArchived }))) {
        stats.filteredWorkspace++
        continue
      }
      if (merged.has(sessionId)) continue
      const snippet = clipCodePoints(typeof hit.snippet === 'string' ? hit.snippet : '')
      const entry = known || {
        sessionId,
        title: text('未命名会话', 'Untitled conversation') + ' · ' + sessionId.slice(-8),
        workspaceId: '',
        workspaceName: '',
        workspacePath: '',
        archived: catalog.archivedIds.has(sessionId),
        pinned: catalog.pinnedIds.has(sessionId),
        unresolved: true,
      }
      if (!known) stats.unresolved++
      const kinds = metadataMatchKinds(entry, query)
      merged.set(sessionId, makeResult(entry, ['content', ...kinds], snippet, { unresolved: !known }))
      order.push(sessionId)
      stats.contentHits++
    }

    for (const entry of catalog.sessions) {
      if (!isVisibleCatalogSession(entry)) continue
      const kinds = metadataMatchKinds(entry, query)
      if (!kinds.length) continue
      if (!entryMatchesFilters(entry, { workspaceId, includeArchived })) continue
      if (merged.has(entry.sessionId)) {
        const existing = merged.get(entry.sessionId)
        existing.matchKinds = [...new Set([...existing.matchKinds, ...kinds])]
        continue
      }
      merged.set(entry.sessionId, makeResult(entry, kinds, ''))
      order.push(entry.sessionId)
      stats.metadataHits++
    }

    const items = order.map(sessionId => merged.get(sessionId))
    return {
      items,
      stats,
      hasMore: input.hasMore === true,
      contentEmpty: stats.contentHits === 0,
      metadataOnly: stats.contentHits === 0 && stats.metadataHits > 0,
    }
  }

  /** Local title/session-ID matches shown only when the Host cannot search content. */
  function localMetadataMatches(catalog, query, filters = {}) {
    const items = []
    for (const entry of catalog.sessions) {
      if (!isVisibleCatalogSession(entry)) continue
      const kinds = metadataMatchKinds(entry, String(query || '').trim())
      if (!kinds.length) continue
      if (!entryMatchesFilters(entry, filters)) continue
      items.push(makeResult(entry, kinds, '', { localOnly: true }))
    }
    return items
  }

  function errorCode(error) {
    const code = error && (error.code || error.rpcCode || error.errorCode)
    return code == null ? '' : String(code)
  }

  function errorStatus(error) {
    const status = Number(error && (error.status || error.httpStatus))
    return Number.isFinite(status) ? status : 0
  }

  function errorMessage(error) {
    if (!error) return ''
    if (typeof error === 'string') return error
    return String(error.message || error.error || '')
  }

  /**
   * Classify a Host search failure. "No permission", "no results", "failed"
   * and "this Host version does not support search" stay distinct.
   */
  function classifySearchError(error) {
    const code = errorCode(error).toLowerCase()
    const status = errorStatus(error)
    const message = errorMessage(error)
    const lower = message.toLowerCase()
    if (code === 'session/search-disabled' || (code === 'gateway/internal' && /session search is disabled:/i.test(message))) {
      return {
        status: STATUS.UNSUPPORTED,
        kind: 'disabled',
        code: 'session/search-disabled',
        message: text('主机未启用全文会话搜索。可按本机已加载的标题或会话 ID 筛选。', 'Full-text search is disabled on the Host. Loaded titles and session IDs can still be filtered.'),
        detail: '',
      }
    }
    const unsupportedCode = [
      'method-unavailable', 'not-found', 'unsupported-method', 'unsupported_endpoint',
      'unsupported-method', 'no-generated-rpc-adapter', 'upstream-incompatible', 'gateway/not-found',
    ].includes(code)
    const unsupported = unsupportedCode || [404, 405, 501].includes(status)
      || /does not mount|not available on this host|unsupported|no generated rpc adapter|method-unavailable/i.test(message)
    if (unsupported) {
      return {
        status: STATUS.UNSUPPORTED,
        kind: 'unsupported',
        code: code || `http-${status || 'unknown'}`,
        message: text('当前主机版本不支持全文会话搜索（session.search）。', 'This Host version does not support full-text session search (session.search).'),
        detail: message,
      }
    }
    if (code === 'auth' || code === 'unauthorized' || code === 'permission-denied' || status === 401 || status === 403) {
      return {
        status: STATUS.DENIED,
        kind: 'auth',
        code: code || `http-${status || 'auth'}`,
        message: text('无权限或登录已失效，搜索未执行。', 'Permission denied or the session expired; no search was performed.'),
        detail: message,
      }
    }
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError' || /timeout/i.test(code))) {
      return {
        status: STATUS.ERROR,
        kind: 'timeout',
        code: code || 'timeout',
        message: text('搜索超时，请重试。不会自动重试。', 'The search timed out. Retry manually; it is not retried automatically.'),
        detail: message,
      }
    }
    return {
      status: STATUS.ERROR,
      kind: 'failed',
      code: code || 'search-failed',
      message: text('搜索失败：主机未能完成本次搜索。', 'The search failed: the Host could not complete it.'),
      detail: message,
    }
  }

  function statusMessage(status, stats) {
    if (status === STATUS.EMPTY) return text('没有匹配的会话。可尝试更换关键词、包含归档或切换工作区。', 'No matching conversations. Try another query, include archived conversations, or switch workspace.')
    if (status === STATUS.LOADING) return text('正在主机搜索会话正文…', 'Searching conversation content on the Host…')
    if (status === STATUS.DENIED) return text('无权限或登录已失效，搜索未执行。', 'Permission denied or signed out; no search was performed.')
    if (status === STATUS.ERROR) return text('搜索失败。未使用本地列表筛选代替全文搜索。', 'Search failed. Local list filtering was not used as a substitute.')
    if (status === STATUS.UNSUPPORTED) return text('当前主机版本不支持全文会话搜索。', 'This Host version does not support full-text session search.')
    if (status === STATUS.RESULTS) {
      if (stats && stats.contentHits > 0) {
        return text(`正文命中 ${stats.contentHits} 个会话${stats.metadataHits ? `，另有 ${stats.metadataHits} 个标题/ID 匹配` : ''}。`, `${stats.contentHits} conversation content ${stats.contentHits === 1 ? 'hit' : 'hits'}${stats.metadataHits ? `, plus ${stats.metadataHits} title/ID ${stats.metadataHits === 1 ? 'match' : 'matches'}` : ''}.`)
      }
      return text('正文搜索没有命中；以下仅为本地标题/会话 ID 匹配，未搜索历史正文。', 'No content hits. The rows below are local title/session-ID matches only; history content was not searched.')
    }
    return ''
  }

  function matchLabel(kinds) {
    const labels = []
    if (kinds.includes('content')) labels.push(text('正文命中', 'Content hit'))
    if (kinds.includes('title')) labels.push(text('标题匹配', 'Title match'))
    if (kinds.includes('sessionId')) labels.push(text('会话 ID 匹配', 'Session ID match'))
    return labels
  }

  /** Escape text, wrapping case-insensitive query occurrences in <mark>. */
  function highlight(textValue, query) {
    const source = String(textValue == null ? '' : textValue)
    const needle = String(query == null ? '' : query).trim()
    if (!needle) return esc(source)
    const lowerSource = source.toLowerCase()
    const lowerNeedle = needle.toLowerCase()
    let index = 0
    let from = 0
    let html = ''
    while (index < source.length) {
      const found = lowerSource.indexOf(lowerNeedle, index)
      if (found < 0) break
      html += esc(source.slice(from, found))
      html += '<mark>' + esc(source.slice(found, found + needle.length)) + '</mark>'
      index = found + needle.length
      from = index
      if (!lowerNeedle.length) break
    }
    html += esc(source.slice(from))
    return html
  }

  function workspaceOptionRows(workspaces) {
    const rows = [{ id: '', label: text('全部工作区', 'All workspaces') }]
    for (const workspace of workspaces) {
      rows.push({ id: workspace.workspaceId, label: workspace.path && workspace.path !== workspace.name ? `${workspace.name} — ${workspace.path}` : workspace.name })
    }
    rows.push({ id: UNGROUPED, label: text('未分组', 'Ungrouped') })
    return rows
  }

  function resultHtml(item, query) {
    const labels = matchLabel(item.matchKinds)
    const workspace = item.workspace
      ? `<span class="dr-search-result-workspace" title="${esc(item.workspace.path)}">⌂ ${esc(item.workspace.name)}</span>`
      : `<span class="dr-search-result-workspace dr-search-result-workspace-unknown">⌂ ${esc(text('工作区未知', 'Workspace unknown'))}</span>`
    const snippet = item.snippet
      ? `<p class="dr-search-snippet">${highlight(item.snippet, query)}</p>`
      : `<p class="dr-search-snippet dr-search-snippet-empty">${esc(text('标题/会话 ID 匹配，主机未返回正文片段。', 'Title/session-ID match; the Host returned no content snippet.'))}</p>`
    const badges = labels.map(label => `<span class="dr-search-badge">${esc(label)}</span>`).join('')
    return `<li class="dr-search-result" data-dr-search-result data-session-id="${esc(item.sessionId)}">
      <button type="button" class="dr-search-result-main" data-dr-search-open="${esc(item.sessionId)}" data-dr-search-snippet="${esc(item.snippet || '')}">
        <span class="dr-search-result-head"><span class="dr-search-result-title">${esc(item.title)}</span>${badges}</span>
        ${workspace}
        ${snippet}
        <span class="dr-search-result-id">${esc(String(item.sessionId).slice(-12))}</span>
      </button>
    </li>`
  }

  function statusHtml(state) {
    const status = state.status || STATUS.IDLE
    if (status === STATUS.IDLE) {
      return `<div class="dr-search-status dr-search-status-idle" data-dr-search-status>${esc(text('输入关键词后由主机搜索标题、会话 ID 与历史正文。仅返回当前设备有权的会话。', 'Search titles, session IDs and history content on the Host. Only conversations this device may access are returned.'))}</div>`
    }
    let extra = ''
    if (status === STATUS.RESULTS && state.metadataOnly) {
      extra = `<div class="dr-search-notice dr-search-notice-metadata" data-dr-search-mode="metadata">${esc(text('正文搜索没有命中；以下仅为本地标题/会话 ID 匹配，未搜索历史正文。', 'No content hits. The rows below are local title/session-ID matches only; history content was not searched.'))}</div>`
    }
    if (status === STATUS.UNSUPPORTED) {
      extra = state.localMatches && state.localMatches.length
        ? `<div class="dr-search-notice dr-search-notice-local" data-dr-search-mode="local">${esc(text('以下仅为本地标题/会话 ID 匹配，未搜索历史正文；不能视为全文搜索结果。', 'The rows below are local title/session-ID matches only, not full-text results; history content was not searched.'))}</div>`
        : `<div class="dr-search-notice dr-search-notice-local" data-dr-search-mode="local">${esc(text('未执行正文搜索，本地列表也未冒充搜索结果。', 'Content search was not performed, and the local list was not presented as search results.'))}</div>`
    }
    if (status === STATUS.ERROR || status === STATUS.DENIED) {
      const detail = state.error && state.error.detail ? ` <span class="dr-search-detail">${esc(clipCodePoints(state.error.detail, 200))}</span>` : ''
      extra = `<div class="dr-search-error-text">${esc(state.error && state.error.message ? state.error.message : '')}${detail}</div>`
        + `<button type="button" class="dr-search-retry" data-dr-search-retry>${esc(text('重试', 'Retry'))}</button>`
    }
    const message = status === STATUS.RESULTS || status === STATUS.UNSUPPORTED
      ? statusMessage(status, state.stats)
      : (state.error && state.error.message) || statusMessage(status)
    return `<div class="dr-search-status dr-search-status-${esc(status)}" data-dr-search-status data-status="${esc(status)}" role="status" aria-live="polite">${esc(message)}${extra}</div>`
  }

  function renderWorkspaceOptions(value) {
    const workspaces = Array.isArray(value.workspaces) ? value.workspaces : []
    return workspaceOptionRows(workspaces).map(row =>
      `<option value="${esc(row.id)}"${String(row.id) === String(value.workspaceId || '') ? ' selected' : ''}>${esc(row.label)}</option>`).join('')
  }

  function searchButtonText(status) {
    return status === STATUS.LOADING ? text('搜索中…', 'Searching…') : text('搜索', 'Search')
  }

  function renderSearchResults(value, status) {
    const listItems = status === STATUS.UNSUPPORTED
      ? (value.localMatches || [])
      : (value.items || [])
    const listTitle = status === STATUS.UNSUPPORTED && listItems.length
      ? `<div class="dr-search-list-title">${esc(text('本地标题/会话 ID 匹配', 'Local title/session-ID matches'))}</div>`
      : ''
    const results = listItems.length
      ? `${listTitle}<ul class="dr-search-results" data-dr-search-results>${listItems.map(item => resultHtml(item, value.query || '')).join('')}</ul>`
      : ''
    const stats = value.stats || {}
    let footer = ''
    if (status === STATUS.RESULTS || (status === STATUS.UNSUPPORTED && listItems.length)) {
      const parts = []
      if (status === STATUS.RESULTS && stats.contentHits != null) parts.push(text(`主机正文命中 ${stats.contentHits} 条`, `${stats.contentHits} Host content ${stats.contentHits === 1 ? 'hit' : 'hits'}`))
      if (status === STATUS.UNSUPPORTED) parts.push(text('主机未执行正文搜索', 'Host content search was not performed'))
      if (stats.metadataHits) parts.push(text(`${stats.metadataHits} 条标题/ID 匹配`, `${stats.metadataHits} title/ID ${stats.metadataHits === 1 ? 'match' : 'matches'}`))
      if (stats.filteredArchived) parts.push(text(`隐藏 ${stats.filteredArchived} 条归档会话`, `${stats.filteredArchived} archived hidden`))
      if (stats.filteredWorkspace) parts.push(text(`工作区外 ${stats.filteredWorkspace} 条`, `${stats.filteredWorkspace} outside workspace`))
      if (value.hasMore) parts.push(text(`主机仅返回前 ${HOST_RESULT_LIMIT} 条`, `Host returned the first ${HOST_RESULT_LIMIT} only`))
      if (parts.length) footer = `<div class="dr-search-footer" data-dr-search-footer>${esc(parts.join(' · '))}</div>`
    }
    return `${statusHtml(value)}${results}${footer}`
  }

  /** Pure markup for the whole search panel; safe to render with innerHTML. */
  function renderSearchHtml(state = {}) {
    const value = state || {}
    const status = value.status || STATUS.IDLE
    const archived = value.includeArchived === true
    return `<section class="dr-search" data-dr-search data-status="${esc(status)}">
      <form class="dr-search-form" data-dr-search-form role="search" autocomplete="off">
        <label class="dr-search-field dr-search-query-field">
          <span class="dr-search-label">${esc(text('搜索会话', 'Search conversations'))}</span>
          <input class="dr-search-input" data-dr-search-input type="search" name="dr-search-query" maxlength="${MAX_QUERY_CHARS}" value="${esc(value.query || '')}" placeholder="${esc(text('标题、会话 ID 或历史正文', 'Title, session ID or history content'))}">
        </label>
        <div class="dr-search-field dr-search-workspace-field">
          <label for="session-search-workspace" class="dr-search-label">${esc(text('工作区', 'Workspace'))}</label>
          <select id="session-search-workspace" class="dr-search-workspace" data-dr-search-workspace>${renderWorkspaceOptions(value)}</select>
        </div>
        <label class="dr-search-check"><input type="checkbox" data-dr-search-archived${archived ? ' checked' : ''}> ${esc(text('包含归档', 'Include archived'))}</label>
        <button type="submit" class="dr-search-submit" data-dr-search-submit${status === STATUS.LOADING ? ' disabled' : ''}>${esc(searchButtonText(status))}</button>
      </form>
      <div class="dr-search-hint">${esc(text('正文搜索由主机执行并按其可见范围过滤；结果不会用本地列表筛选冒充。', 'Content search runs on the Host and is filtered by its visibility rules; local list filtering is never presented as content results.'))}</div>
      <div class="dr-search-feedback" data-dr-search-feedback>${renderSearchResults(value, status)}</div>
    </section>`
  }

  function normalizeSnippet(value) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim() }

  /**
   * Locate a Host snippet in already rendered history. The Host search contract
   * returns only {sessionId, snippet}, so the turn is found by snippet text in
   * the rendered history; when an ancestor carries data-seq, that seq is returned.
   */
  function locateSnippet(historyRoot, snippet, options = {}) {
    const needle = normalizeSnippet(snippet)
    if (!historyRoot || !needle) return { found: false, element: null, turnSeq: null, reason: 'empty' }
    const elements = []
    if (typeof historyRoot.matches === 'function' && historyRoot.matches(options.resultSelector || '[data-seq]')) elements.push(historyRoot)
    if (typeof historyRoot.querySelectorAll === 'function') {
      try { for (const element of historyRoot.querySelectorAll(options.candidateSelector || '*')) elements.push(element) } catch {}
    }
    const target = needle.toLowerCase()
    let best = null
    let matchedBy = ''
    for (const element of elements) {
      const tag = String(element.tagName || '').toUpperCase()
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'INPUT') continue
      const content = String(element.textContent == null ? '' : element.textContent)
      let hit = content.includes(needle) || content.toLowerCase().includes(target)
      let by = hit ? (content.includes(needle) ? 'exact' : 'normalized') : ''
      if (!hit) {
        const collapsed = normalizeSnippet(content)
        hit = collapsed.toLowerCase().includes(target)
        by = hit ? 'collapsed' : ''
      }
      if (!hit) continue
      if (!best || content.length < best.contentLength) {
        best = { element, contentLength: content.length }
        matchedBy = by
      }
    }
    if (!best) return { found: false, element: null, turnSeq: null, reason: 'not-rendered' }
    const element = best.element
    try { element.classList && element.classList.add('dr-search-located') } catch {}
    try { if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch {}
    let turnSeq = null
    try {
      const holder = typeof element.closest === 'function' ? element.closest('[data-seq]') : null
      const raw = holder && holder.dataset ? holder.dataset.seq : null
      if (raw != null && Number.isFinite(Number(raw))) turnSeq = Number(raw)
    } catch {}
    return { found: true, element, turnSeq, matchedBy }
  }

  /**
   * Poll for a snippet while history renders asynchronously. The first argument
   * may be an element or a getter that re-reads the current history root.
   */
  function waitForSnippet(historyRoot, snippet, options = {}) {
    const getRoot = typeof historyRoot === 'function' ? historyRoot : () => historyRoot
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 4000
    const intervalMs = Number.isFinite(options.intervalMs) ? Math.max(20, options.intervalMs) : 120
    const attempt = () => {
      const rootValue = getRoot()
      if (!rootValue) return { found: false, element: null, turnSeq: null, reason: 'no-root' }
      return locateSnippet(rootValue, snippet, options)
    }
    const immediate = attempt()
    if (immediate.found || timeoutMs === 0) return Promise.resolve(immediate)
    return new Promise(resolve => {
      const startedAt = Date.now()
      const tick = () => {
        const result = attempt()
        if (result.found) { resolve(result); return }
        if (Date.now() - startedAt >= timeoutMs) { resolve({ ...result, reason: result.reason || 'timeout' }); return }
        if (typeof root.setTimeout === 'function') root.setTimeout(tick, intervalMs)
        else setTimeout(tick, intervalMs)
      }
      if (typeof root.setTimeout === 'function') root.setTimeout(tick, intervalMs)
      else setTimeout(tick, intervalMs)
    })
  }

  function adapterValue(adapter, method, fallback) {
    if (!adapter || typeof adapter[method] !== 'function') return fallback
    try { const value = adapter[method](); return value == null ? fallback : value } catch { return fallback }
  }

  function buildCatalog(adapter) {
    return normalizeCatalog({
      sessions: adapterValue(adapter, 'sessions', []),
      workspaces: adapterValue(adapter, 'workspaces', []),
      archivedSessionIds: adapterValue(adapter, 'archivedSessionIds', []),
      pinnedSessionIds: adapterValue(adapter, 'pinnedSessionIds', []),
      titleOf: typeof adapter.titleOf === 'function' ? adapter.titleOf : undefined,
    })
  }

  function createController(adapter) {
    if (!adapter || typeof adapter.rpc !== 'function') throw new TypeError('DshSessionSearch.init requires an adapter.rpc(method, payload, options) function')
    let generation = 0
    let controllerRef = null
    let internalAbort = null
    let last = { query: '', workspaceId: '', includeArchived: false }
    let state = {
      status: STATUS.IDLE,
      query: '',
      workspaceId: '',
      includeArchived: false,
      items: [],
      localMatches: [],
      workspaces: [],
      stats: {},
      hasMore: false,
      metadataOnly: false,
      error: null,
      cancelled: false,
    }

    function snapshot() {
      return {
        ...state,
        items: state.items.slice(),
        localMatches: state.localMatches.slice(),
        workspaces: state.workspaces.slice(),
        stats: { ...state.stats },
        error: state.error ? { ...state.error } : null,
      }
    }

    function publish() {
      const value = snapshot()
      try { if (typeof adapter.onState === 'function') adapter.onState(value) } catch {}
      return value
    }

    function resolveHistoryRoot() {
      if (typeof adapter.historyRoot === 'function') {
        try { const value = adapter.historyRoot(); if (value) return value } catch {}
      }
      const doc = adapter.document || root.document
      if (doc && typeof doc.getElementById === 'function') return doc.getElementById(adapter.historyElementId || 'history')
      return null
    }

    function localState(query, catalog, filters) {
      return { matches: localMetadataMatches(catalog, query, filters) }
    }

    async function search(options = {}) {
      const normalized = normalizeQuery(options.query == null ? state.query : options.query)
      const workspaceId = options.workspaceId == null ? state.workspaceId : String(options.workspaceId)
      const includeArchived = options.includeArchived == null ? state.includeArchived : options.includeArchived === true
      last = { query: normalized.query || String(options.query == null ? state.query : options.query), workspaceId, includeArchived }
      if (!normalized.ok) {
        state = { ...state, status: STATUS.IDLE, query: last.query, workspaceId, includeArchived, items: [], localMatches: [], stats: {}, metadataOnly: false, error: null }
        publish()
        return { ...snapshot(), validationError: normalized.error, validationMessage: normalized.message }
      }
      if (options.signal && options.signal.aborted) return snapshot()
      const catalog = buildCatalog(adapter)
      const filters = { workspaceId, includeArchived }
      state = {
        ...state,
        status: STATUS.LOADING,
        query: normalized.query,
        workspaceId,
        includeArchived,
        workspaces: catalog.workspaces.map(workspace => ({ workspaceId: workspace.workspaceId, name: workspace.name, path: workspace.path })),
        items: [],
        localMatches: [],
        stats: {},
        hasMore: false,
        metadataOnly: false,
        error: null,
        cancelled: false,
        validationMessage: '',
      }
      publish()

      const markUnsupported = classified => {
        const local = localState(normalized.query, catalog, filters)
        state = {
          ...state,
          status: STATUS.UNSUPPORTED,
          items: [],
          localMatches: local.matches,
          stats: { contentHits: 0, metadataHits: local.matches.length, filteredArchived: 0, filteredWorkspace: 0 },
          hasMore: false,
          metadataOnly: local.matches.length > 0,
          error: classified,
        }
        return publish()
      }

      if (typeof adapter.searchSupported === 'function' && adapter.searchSupported() === false) {
        return markUnsupported({
          status: STATUS.UNSUPPORTED,
          kind: 'unsupported',
          code: 'capability-disabled',
          message: text('当前主机版本不支持全文会话搜索（session.search）。', 'This Host version does not support full-text session search (session.search).'),
          detail: '',
        })
      }

      const requestId = ++generation
      try {
        if (internalAbort) { try { internalAbort.abort() } catch {} }
        internalAbort = typeof AbortController === 'function' ? new AbortController() : null
        const signal = options.signal || (internalAbort ? internalAbort.signal : undefined)
        const value = await adapter.rpc('session.search', { query: normalized.query }, { signal, timeoutMs: options.timeoutMs })
        if (requestId !== generation) return snapshot()
        const hostItems = value && Array.isArray(value.items) ? value.items : null
        if (!hostItems || hostItems.some(item => !item || typeof item.sessionId !== 'string')) {
          const classified = { status: STATUS.ERROR, kind: 'invalid-response', code: 'invalid-response', message: text('搜索失败：主机返回了无法识别的结果。', 'Search failed: the Host returned an unrecognised result.'), detail: '' }
          state = { ...state, status: STATUS.ERROR, items: [], localMatches: [], stats: {}, error: classified }
          return publish()
        }
        const merged = mergeSearchResults({ catalog, query: normalized.query, hostItems, ...filters, hasMore: value.hasMore === true })
        state = {
          ...state,
          status: merged.items.length ? STATUS.RESULTS : STATUS.EMPTY,
          items: merged.items,
          localMatches: [],
          stats: merged.stats,
          hasMore: merged.hasMore,
          metadataOnly: merged.metadataOnly,
          error: null,
        }
        return publish()
      } catch (error) {
        if (requestId !== generation) return snapshot()
        const aborted = !!(options.signal && options.signal.aborted)
          || (error && (error.name === 'AbortError' || /aborted/i.test(String(error.message || ''))))
        if (aborted) {
          state = { ...state, status: STATUS.IDLE, items: [], localMatches: [], stats: {}, metadataOnly: false, error: null, cancelled: true }
          return publish()
        }
        const classified = classifySearchError(error)
        if (classified.status === STATUS.UNSUPPORTED) return markUnsupported(classified)
        state = { ...state, status: classified.status, items: [], localMatches: [], stats: {}, metadataOnly: false, error: classified }
        return publish()
      }
    }

    function cancelSearch() {
      generation++
      if (internalAbort) { try { internalAbort.abort() } catch {} internalAbort = null }
    }

    function retry() {
      const query = last.query || state.query
      return search({ query, workspaceId: last.workspaceId, includeArchived: last.includeArchived })
    }

    async function openResult(itemOrId) {
      const sessionId = typeof itemOrId === 'string' ? itemOrId : itemOrId && itemOrId.sessionId
      if (!sessionId) return { sessionId: '', opened: false, located: false, turnSeq: null, reason: 'missing-session' }
      const fromList = state.items.find(item => item.sessionId === sessionId)
        || state.localMatches.find(item => item.sessionId === sessionId)
      const item = typeof itemOrId === 'object' && itemOrId ? itemOrId : (fromList || { sessionId, snippet: '' })
      const result = { sessionId, opened: false, located: false, turnSeq: null, reason: '' }
      try {
        if (typeof adapter.openSession !== 'function') throw new Error('adapter.openSession is unavailable')
        await adapter.openSession(sessionId, { snippet: item.snippet || '', query: state.query })
        result.opened = true
      } catch (error) {
        result.reason = 'open-failed'
        result.error = classifySearchError(error)
        try { if (typeof adapter.onOpen === 'function') adapter.onOpen(result) } catch {}
        return result
      }
      if (!item.snippet) {
        result.reason = 'no-snippet'
      } else if (typeof adapter.locateSnippet === 'function') {
        try {
          const located = await adapter.locateSnippet({ sessionId, snippet: item.snippet, query: state.query })
          result.located = !!(located && located.found)
          result.turnSeq = located && Number.isFinite(Number(located.turnSeq)) ? Number(located.turnSeq) : null
          if (!result.located) result.reason = (located && located.reason) || 'not-rendered'
        } catch { result.reason = 'locate-failed' }
      } else {
        const located = await waitForSnippet(resolveHistoryRoot, item.snippet, {
          timeoutMs: Number.isFinite(adapter.locateTimeoutMs) ? adapter.locateTimeoutMs : 4000,
        })
        result.located = !!located.found
        result.turnSeq = located.turnSeq == null ? null : located.turnSeq
        if (!located.found) result.reason = located.reason || 'not-rendered'
      }
      if (result.opened && !result.located) {
        try { if (typeof adapter.notice === 'function') adapter.notice(text('会话已打开，但历史中暂未渲染命中片段，未能自动定位回合。', 'Conversation opened, but the matched snippet is not rendered in history yet; the turn could not be located automatically.')) } catch {}
      }
      try { if (typeof adapter.onOpen === 'function') adapter.onOpen(result) } catch {}
      return result
    }

    function setWorkspace(workspaceId) { state = { ...state, workspaceId: String(workspaceId || '') }; return publish() }
    function setIncludeArchived(value) { state = { ...state, includeArchived: value === true }; return publish() }
    function reset() {
      cancelSearch()
      state = { ...state, status: STATUS.IDLE, items: [], localMatches: [], stats: {}, error: null, metadataOnly: false, cancelled: false }
      return publish()
    }
    function syncCatalog() {
      const catalog = buildCatalog(adapter)
      state = { ...state, workspaces: catalog.workspaces.map(workspace => ({ workspaceId: workspace.workspaceId, name: workspace.name, path: workspace.path })) }
      return publish()
    }

    controllerRef = {
      search, cancelSearch, retry, openResult, snapshot, setWorkspace, setIncludeArchived, reset, syncCatalog,
      get statuses() { return STATUS }, adapter,
    }
    return controllerRef
  }

  let instance = null
  function init(adapter) {
    instance = createController(adapter)
    return instance
  }

  /**
   * Mount the panel into a container. The caller owns placement; the module
   * builds its own form/status/results markup and never requires HTML changes.
   */
  function mount(container, controller, options = {}) {
    const doc = options.document || root.document
    if (!container || !doc || typeof doc.createElement !== 'function') return null
    const element = doc.createElement('div')
    element.className = 'dr-search-host'
    container.appendChild(element)
    let destroyed = false
    let workspaceMarkup, english
    const paint = () => {
      if (destroyed) return
      const state = controller.snapshot()
      const workspace = element.querySelector?.('[data-dr-search-workspace]')
      if (!options.enhanceWorkspaceSelect || !workspace || english !== isEnglish()) {
        english = isEnglish()
        element.innerHTML = renderSearchHtml(state)
        workspaceMarkup = renderWorkspaceOptions(state)
        const select = element.querySelector?.('[data-dr-search-workspace]')
        if (select) options.enhanceWorkspaceSelect?.(select)
        return
      }
      // Keep the form attached while results arrive, including when a workspace
      // picker is open or the user has begun typing the next query.
      const newWorkspaceMarkup = renderWorkspaceOptions(state)
      if (workspaceMarkup !== newWorkspaceMarkup) {
        workspaceMarkup = newWorkspaceMarkup
        workspace.innerHTML = newWorkspaceMarkup
      }
      workspace.value = state.workspaceId || ''
      const submit = element.querySelector('[data-dr-search-submit]')
      submit.disabled = state.status === STATUS.LOADING
      submit.textContent = searchButtonText(state.status)
      element.querySelector('[data-dr-search]').dataset.status = state.status
      element.querySelector('[data-dr-search-feedback]').innerHTML = renderSearchResults(state, state.status)
    }
    const unbind = bindPanel(element, controller, { ...options, render: paint })
    paint()
    return {
      element,
      refresh: paint,
      destroy() { destroyed = true; unbind(); if (element.parentNode) element.parentNode.removeChild(element) },
    }
  }

  function readForm(form) {
    const queryInput = form.querySelector && form.querySelector('[data-dr-search-input]')
    const workspaceSelect = form.querySelector && form.querySelector('[data-dr-search-workspace]')
    const archivedInput = form.querySelector && form.querySelector('[data-dr-search-archived]')
    return {
      query: queryInput && 'value' in queryInput ? queryInput.value : '',
      workspaceId: workspaceSelect && 'value' in workspaceSelect ? workspaceSelect.value : '',
      includeArchived: !!(archivedInput && archivedInput.checked),
    }
  }

  /**
   * Delegated bindings for a panel/container. `render` is the caller's redraw
   * hook; when absent the events still drive the controller.
   */
  function bindPanel(panel, controller, options = {}) {
    if (!panel || typeof panel.addEventListener !== 'function') return () => {}
    const redraw = () => {
      try { if (typeof options.render === 'function') options.render() } catch {}
      try { if (typeof options.onState === 'function') options.onState(controller.snapshot()) } catch {}
    }
    const onSubmit = event => {
      const form = event.target && event.target.closest ? event.target.closest('[data-dr-search-form]') : null
      if (!form) return
      if (typeof event.preventDefault === 'function') event.preventDefault()
      const formValues = readForm(form)
      void controller.search({ ...formValues, query: formValues.query }).then(redraw)
    }
    const onClick = event => {
      const target = event.target && event.target.closest ? event.target : null
      if (!target) return
      const retry = target.closest('[data-dr-search-retry]')
      if (retry) { void controller.retry().then(redraw); return }
      const open = target.closest('[data-dr-search-open],[data-dr-search-result]')
      if (!open) return
      const sessionId = open.dataset ? open.dataset.drSearchOpen || open.dataset.sessionId : ''
      const snippet = open.dataset ? open.dataset.drSearchSnippet || '' : ''
      if (sessionId) void controller.openResult({ sessionId, snippet }).then(result => {
        if (typeof options.onOpen === 'function') options.onOpen(result)
        redraw()
      })
    }
    const onChange = event => {
      const target = event.target
      if (!target || !target.closest) return
      if (target.closest('[data-dr-search-workspace]') || target.closest('[data-dr-search-archived]')) {
        const form = target.closest('[data-dr-search-form]')
        if (form) {
          const formValues = readForm(form)
          controller.setWorkspace(formValues.workspaceId)
          controller.setIncludeArchived(formValues.includeArchived)
          if (controller.snapshot().query && controller.snapshot().status !== STATUS.IDLE) {
            void controller.search(formValues).then(redraw)
          }
        }
      }
    }
    panel.addEventListener('submit', onSubmit)
    panel.addEventListener('click', onClick)
    panel.addEventListener('change', onChange)
    return () => {
      panel.removeEventListener('submit', onSubmit)
      panel.removeEventListener('click', onClick)
      panel.removeEventListener('change', onChange)
    }
  }

  const api = {
    statuses: STATUS,
    MAX_QUERY_CHARS,
    MAX_SNIPPET_CODE_POINTS,
    HOST_RESULT_LIMIT,
    UNGROUPED,
    esc,
    text,
    clipCodePoints,
    normalizeQuery,
    pathKey,
    normalizeWorkspace,
    sessionTitle,
    workspaceForSession,
    normalizeCatalog,
    isVisibleCatalogSession,
    mergeSearchResults,
    localMetadataMatches,
    classifySearchError,
    statusMessage,
    highlight,
    renderSearchHtml,
    locateSnippet,
    waitForSnippet,
    createController,
    init,
    mount,
    bindPanel,
    get instance() { return instance },
  }
  Object.defineProperty(api, 'controller', { get: () => instance })
  root.DshSessionSearch = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
