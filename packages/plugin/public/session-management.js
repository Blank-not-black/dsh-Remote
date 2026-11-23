/* dsh-remote session management (C3) — host-authoritative pin/unpin, unarchive,
 * workspace rename and registration removal.
 *
 * All writes go through an explicit adapter; state is only changed after the
 * Host response is verified (or after a read-back reconciles an ambiguous
 * timeout). Read-only/paired devices cannot write. Removing a workspace only
 * deletes its registration: sessions, logs, directories and files stay on disk.
 */
;(function (root) {
  'use strict'

  const KIND = Object.freeze({
    READ_ONLY: 'read-only',
    UNSUPPORTED: 'unsupported',
    AUTH: 'auth',
    CONFLICT: 'conflict',
    NOT_FOUND: 'not-found',
    ARCHIVED_SESSION: 'archived-session',
    TIMEOUT: 'timeout',
    NETWORK: 'network',
    INVALID_RESPONSE: 'invalid-response',
    NOT_VERIFIED: 'not-verified',
    CANCELLED: 'cancelled',
    CONFIRMATION_UNAVAILABLE: 'confirmation-unavailable',
    FAILED: 'failed',
  })

  function isEnglish() { return !!root.I18N && root.I18N.lang === 'en' }
  function text(zh, en) { return isEnglish() ? en : zh }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))
  }
  function clip(value, max) {
    const points = Array.from(String(value == null ? '' : value))
    return points.length <= max ? points.join('') : points.slice(0, max).join('') + '…'
  }
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

  /** Workspace ownership: explicit workspaceId, membership list, then cwd inside path. */
  function sessionBelongsToWorkspace(workspace, session) {
    if (!workspace || !session || !session.sessionId) return false
    const sessionId = String(session.sessionId)
    if (typeof session.workspaceId === 'string' && session.workspaceId === workspace.workspaceId) return true
    if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.some(id => String(id) === sessionId)) return true
    const cwdKey = pathKey(session.cwd)
    const workspaceKey = pathKey(workspace.path)
    if (!cwdKey || !workspaceKey) return false
    return cwdKey === workspaceKey || cwdKey.startsWith(workspaceKey.endsWith('/') ? workspaceKey : workspaceKey + '/')
  }

  /** Everything a user must understand before a workspace registration is removed. */
  function workspaceImpact(workspace, sessions, options = {}) {
    const normalized = normalizeWorkspace(workspace)
    const archived = new Set((options.archivedSessionIds || []).map(String))
    const pinned = new Set((options.pinnedSessionIds || []).map(String))
    const rows = []
    const seen = new Set()
    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (!session || !session.sessionId) continue
      if (!sessionBelongsToWorkspace(normalized, session)) continue
      const sessionId = String(session.sessionId)
      if (seen.has(sessionId)) continue
      seen.add(sessionId)
      rows.push({
        sessionId,
        title: sessionTitle(session, options.titleOf),
        archived: archived.has(sessionId),
        pinned: pinned.has(sessionId),
      })
    }
    return {
      workspaceId: normalized ? normalized.workspaceId : '',
      name: normalized ? normalized.name : '',
      path: normalized ? normalized.path : '',
      total: rows.length,
      sessions: rows,
      archivedCount: rows.filter(row => row.archived).length,
      pinnedCount: rows.filter(row => row.pinned).length,
    }
  }

  /** DSH trims, rejects blank titles and refuses exact duplicate titles. */
  function validateWorkspaceTitle(rawValue, options = {}) {
    const title = String(rawValue == null ? '' : rawValue).trim()
    if (!title) return { ok: false, title: '', error: 'blank', message: text('工作区名称不能为空。', 'A workspace name cannot be blank.') }
    const workspaces = (Array.isArray(options.workspaces) ? options.workspaces : [])
      .map(normalizeWorkspace).filter(Boolean)
    const currentId = options.currentWorkspaceId || ''
    const current = workspaces.find(workspace => workspace.workspaceId === currentId)
    if (current && current.title === title) {
      return { ok: false, title, error: 'unchanged', message: text('名称未改变。', 'The name is unchanged.') }
    }
    if (workspaces.some(workspace => workspace.workspaceId !== currentId && workspace.title === title)) {
      return { ok: false, title, error: 'conflict', message: text(`名称「${title}」已被其他工作区使用。`, `The name "${title}" is already used by another workspace.`) }
    }
    return { ok: true, title, error: null, message: '' }
  }

  function idsArray(value, key) {
    return value && Array.isArray(value[key]) ? value[key].map(String) : null
  }

  function applyPinResult(value, sessionId, action) {
    const ids = idsArray(value, 'pinnedSessionIds')
    if (!ids) return { ok: false, error: 'invalid-response', message: text('主机未返回置顶集合，无法确认写入结果。', 'The Host returned no pin set, so the write cannot be confirmed.') }
    const id = String(sessionId)
    const included = ids.includes(id)
    if (action === 'unpin' ? included : !included) {
      return { ok: false, error: 'not-verified', message: text('主机未确认置顶状态变更。', 'The Host did not confirm the pin change.'), pinnedSessionIds: ids }
    }
    return { ok: true, pinnedSessionIds: ids }
  }

  function applyUnarchiveResult(value, sessionId) {
    const ids = idsArray(value, 'archivedSessionIds')
    if (!ids) return { ok: false, error: 'invalid-response', message: text('主机未返回归档集合，无法确认取消归档结果。', 'The Host returned no archive set, so the unarchive cannot be confirmed.') }
    if (ids.includes(String(sessionId))) {
      return { ok: false, error: 'not-verified', message: text('主机仍将该会话标记为归档，取消归档未生效。', 'The Host still marks the session archived; unarchive did not take effect.'), archivedSessionIds: ids }
    }
    return { ok: true, archivedSessionIds: ids }
  }

  function applyRenameResult(value, workspaceId, title) {
    const workspace = value && value.workspace && typeof value.workspace === 'object' ? value.workspace : null
    if (!workspace || String(workspace.workspaceId || '') !== String(workspaceId || '')) {
      return { ok: false, error: 'invalid-response', message: text('主机未返回被重命名的工作区。', 'The Host returned no renamed workspace.') }
    }
    if (String(workspace.title || '').trim() !== String(title || '').trim()) {
      return { ok: false, error: 'not-verified', message: text('主机返回的工作区名称与新名称不一致。', 'The workspace name returned by the Host differs from the requested name.'), workspace }
    }
    return { ok: true, workspace }
  }

  function applyDeleteResult(value) {
    if (!value || value.deleted !== true) {
      return { ok: false, error: 'invalid-response', message: text('主机未确认工作区登记已删除。', 'The Host did not confirm the workspace registration deletion.') }
    }
    return { ok: true, deleted: true }
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

  const UNSUPPORTED_CODES = new Set([
    'method-unavailable', 'not-found', 'unsupported-method', 'unsupported_endpoint',
    'no-generated-rpc-adapter', 'upstream-incompatible', 'gateway/not-found',
  ])

  /** Map a Host write failure to an actionable kind, including ambiguity. */
  function classifyManagementError(error) {
    const code = errorCode(error).toLowerCase()
    const status = errorStatus(error)
    const message = errorMessage(error)
    if (UNSUPPORTED_CODES.has(code) || [404, 405, 501].includes(status)
      || /no generated rpc adapter|method-unavailable|does not mount|unsupported/i.test(message)) {
      return {
        kind: KIND.UNSUPPORTED,
        ambiguous: false,
        code: code || `http-${status || 'unknown'}`,
        message: text('当前主机或网关版本不支持该管理操作，未写入任何状态。', 'This Host or gateway version does not support this management action; nothing was written.'),
        detail: message,
      }
    }
    if (code === 'auth' || code === 'unauthorized' || code === 'permission-denied' || status === 401 || status === 403) {
      return {
        kind: KIND.AUTH,
        ambiguous: false,
        code: code || `http-${status || 'auth'}`,
        message: text('无权限或登录已失效，操作未执行。', 'Permission denied or signed out; nothing was changed.'),
        detail: message,
      }
    }
    if (code === 'workspace/name-conflict' || /already in use|name-conflict/i.test(message)) {
      return {
        kind: KIND.CONFLICT,
        ambiguous: false,
        code: code || 'workspace/name-conflict',
        message: text('该工作区名称已被使用，未修改。', 'That workspace name is already in use; nothing was changed.'),
        detail: message,
      }
    }
    if (code === 'workspace/archived-session' || /archived session/i.test(message)) {
      return {
        kind: KIND.ARCHIVED_SESSION,
        ambiguous: false,
        code: code || 'workspace/archived-session',
        message: text('归档会话不能置顶；请先取消归档。', 'An archived conversation cannot be pinned; unarchive it first.'),
        detail: message,
      }
    }
    if (code === 'session/not-found' || code === 'workspace/not-found'
      || /not found/i.test(message) && /session|workspace/i.test(message)) {
      return {
        kind: KIND.NOT_FOUND,
        ambiguous: false,
        code: code || 'not-found',
        message: text('目标会话或工作区不存在，可能已被其他客户端更新。', 'The session or workspace no longer exists; another client may have updated it.'),
        detail: message,
      }
    }
    const timeout = error && ['AbortError', 'TimeoutError'].includes(error.name)
      || ['timeout', 'operation-pending', 'upstream-uncertain', 'unknown'].includes(code)
      || [502, 503, 504].includes(status)
      || /timeout|unconfirmed|upstream-unreachable|network|fetch failed/i.test(message)
    if (timeout) {
      return {
        kind: /network|fetch failed|upstream-unreachable/i.test(message) ? KIND.NETWORK : KIND.TIMEOUT,
        ambiguous: true,
        code: code || 'timeout',
        message: text('写入结果未知（超时/连接中断）。正在核对主机状态，不会盲目重试。', 'The write outcome is unknown (timeout or connection loss). Checking Host state; the write is not retried blindly.'),
        detail: message,
      }
    }
    return {
      kind: KIND.FAILED,
      ambiguous: false,
      code: code || 'write-failed',
      message: text('主机拒绝了本次操作，未修改任何状态。', 'The Host rejected the operation; nothing was changed.'),
      detail: message,
    }
  }

  /** Confirmation payload for workspace registration removal. */
  function removeWorkspaceConfirmation(workspace, impact, options = {}) {
    const normalized = normalizeWorkspace(workspace)
    const name = normalized ? normalized.name : (impact && impact.name) || ''
    const path = normalized ? normalized.path : (impact && impact.path) || ''
    const total = impact && Number.isFinite(impact.total) ? impact.total : 0
    const sample = impact && Array.isArray(impact.sessions) ? impact.sessions.slice(0, 8) : []
    const lines = []
    lines.push(text(`移除工作区登记「${name}」？`, `Remove workspace registration "${name}"?`))
    if (path) lines.push(text(`路径：${path}`, `Path: ${path}`))
    lines.push(total
      ? text(`影响：该工作区当前登记了 ${total} 个会话，移除后将不再归属该工作区。`, `Impact: ${total} ${total === 1 ? 'conversation is' : 'conversations are'} registered to this workspace; after removal they no longer belong to it.`)
      : text('影响：当前没有会话登记到该工作区。', 'Impact: no conversations are registered to this workspace.'))
    if (sample.length) {
      lines.push(text('会话示例：', 'Example conversations:'))
      for (const session of sample) lines.push('- ' + clip(session.title, 80))
    }
    if (impact && impact.archivedCount) lines.push(text(`其中 ${impact.archivedCount} 个处于归档状态。`, `${impact.archivedCount} of them are archived.`))
    if (impact && impact.pinnedCount) lines.push(text(`其中 ${impact.pinnedCount} 个处于置顶状态。`, `${impact.pinnedCount} of them are pinned.`))
    lines.push('')
    lines.push(text('此操作只移除 DSH 中的工作区登记，不删除磁盘目录、文件或会话历史。会话本身不会被删除。', 'This only removes the workspace registration in DSH. The directory, files and conversation history on disk are not deleted, and conversations themselves are not deleted.'))
    return {
      title: text('移除工作区登记', 'Remove workspace registration'),
      message: lines.join('\n'),
      confirmLabel: options.confirmLabel || text('仅移除登记', 'Remove registration only'),
      cancelLabel: options.cancelLabel || text('取消', 'Cancel'),
      impact: impact || { total: 0, sessions: [] },
    }
  }

  function adapterValue(adapter, method, fallback) {
    if (!adapter || typeof adapter[method] !== 'function') return fallback
    try { const value = adapter[method](); return value == null ? fallback : value } catch { return fallback }
  }

  function createManager(adapter) {
    if (!adapter || typeof adapter.rpc !== 'function') throw new TypeError('DshSessionManagement.init requires an adapter.rpc(method, payload, options) function')
    const writeTimeoutMs = Number.isFinite(adapter.writeTimeoutMs) ? adapter.writeTimeoutMs : 12000
    const inflight = new Map()
    let lastResult = null
    let lastError = null
    let busyKey = ''
    const host = {
      workspaces: [],
      sessions: [],
      archived: new Set(),
      pinned: new Set(),
    }

    function writable() {
      if (adapter.readOnly === true) return false
      if (typeof adapter.readOnly === 'function') {
        try { if (adapter.readOnly() === true) return false } catch { return false }
      }
      if (typeof adapter.canWrite === 'function') {
        try { if (adapter.canWrite() === false) return false } catch { return false }
      }
      return true
    }

    function notify() {
      try { if (typeof adapter.onState === 'function') adapter.onState(snapshot()) } catch {}
    }

    function hydrate(extra = {}) {
      const workspaces = adapterValue(adapter, 'workspaces', [])
      host.workspaces = (Array.isArray(workspaces) ? workspaces : []).map(normalizeWorkspace).filter(Boolean)
      const sessions = adapterValue(adapter, 'sessions', [])
      host.sessions = Array.isArray(sessions) ? sessions : []
      host.archived = new Set((Array.isArray(extra.archivedSessionIds) ? extra.archivedSessionIds : adapterValue(adapter, 'archivedSessionIds', [])).map(String))
      host.pinned = new Set((Array.isArray(extra.pinnedSessionIds) ? extra.pinnedSessionIds : adapterValue(adapter, 'pinnedSessionIds', [])).map(String))
      notify()
      return snapshot()
    }

    async function refreshHost(scope) {
      let refreshed = false
      if (typeof adapter.refresh === 'function') {
        try { await adapter.refresh(scope); refreshed = true } catch { refreshed = false }
      }
      // Only overwrite the locally verified state when a fresh Host read really
      // happened; a failed refresh must not resurrect pre-write state.
      if (refreshed) hydrate()
      return refreshed
    }

    function snapshot() {
      return {
        canWrite: writable(),
        workspaces: host.workspaces.map(workspace => ({ ...workspace, sessionIds: workspace.sessionIds.slice() })),
        sessions: host.sessions.slice(),
        archivedSessionIds: [...host.archived],
        pinnedSessionIds: [...host.pinned],
        busyKey,
        lastResult: lastResult ? { ...lastResult } : null,
        lastError: lastError ? { ...lastError } : null,
      }
    }

    function failure(error, extra = {}) {
      lastError = { ...error }
      lastResult = { ok: false, error: lastError, ...extra }
      try { if (typeof adapter.toast === 'function') adapter.toast(lastError.message, 'err') } catch {}
      notify()
      return lastResult
    }

    function success(extra = {}) {
      lastError = null
      lastResult = { ok: true, ...extra }
      notify()
      return lastResult
    }

    function readOnlyFailure() {
      return failure({ kind: KIND.READ_ONLY, ambiguous: false, message: text('只读/配对设备不能修改主机状态。', 'Read-only/paired devices cannot change Host state.') })
    }

    function requireWritable() { return writable() ? null : readOnlyFailure() }

    async function runWrite(config) {
      const key = config.key
      if (inflight.has(key)) return inflight.get(key)
      const job = (async () => {
        busyKey = key
        notify()
        try {
          let value
          try {
            value = await adapter.rpc(config.method, config.payload, { timeoutMs: writeTimeoutMs })
          } catch (error) {
            const classified = classifyManagementError(error)
            if (!classified.ambiguous) return failure(classified)
            const reconciled = await config.reconcile()
            if (reconciled && reconciled.ok) {
              try { if (typeof adapter.toast === 'function') adapter.toast(config.reconciledMessage || config.successMessage, 'ok') } catch {}
              return success({ reconciled: true, method: config.method, ...config.resultExtra })
            }
            return failure({ ...classified, reconciled: false })
          }
          const verified = config.verify(value)
          if (verified.ok) {
            config.apply(verified, value)
            await refreshHost(config.refreshScope)
            try { if (typeof adapter.toast === 'function') adapter.toast(config.successMessage, 'ok') } catch {}
            return success({ method: config.method, ...config.resultExtra })
          }
          const reconciled = await config.reconcile()
          if (reconciled && reconciled.ok) {
            try { if (typeof adapter.toast === 'function') adapter.toast(config.reconciledMessage || config.successMessage, 'ok') } catch {}
            return success({ reconciled: true, method: config.method, ...config.resultExtra })
          }
          return failure({ kind: KIND.NOT_VERIFIED, ambiguous: true, code: 'not-verified', message: verified.message || text('主机未确认写入结果。', 'The Host did not confirm the write.'), detail: '' })
        } finally {
          busyKey = ''
          inflight.delete(key)
          notify()
        }
      })()
      inflight.set(key, job)
      return job
    }

    function requireSession(sessionId) {
      const id = sessionId == null ? '' : String(sessionId)
      if (!id) return failure({ kind: KIND.INVALID_RESPONSE, ambiguous: false, message: text('缺少会话 ID。', 'A session ID is required.') })
      return null
    }

    async function reconcileSet(kind, sessionId, desired) {
      const refreshed = await refreshHost('workspaces')
      if (!refreshed) return { ok: false, reason: 'cannot-verify' }
      const ids = kind === 'pin' ? host.pinned : host.archived
      return { ok: ids.has(String(sessionId)) === desired, reason: 'read-back' }
    }

    async function pin(sessionId) {
      const readOnly = requireWritable(); if (readOnly) return readOnly
      const missing = requireSession(sessionId); if (missing) return missing
      const id = String(sessionId)
      if (host.pinned.has(id)) return success({ noop: true, method: 'workspace.pinSession' })
      if (host.archived.has(id)) {
        return failure({ kind: KIND.ARCHIVED_SESSION, ambiguous: false, code: 'workspace/archived-session', message: text('归档会话不能置顶；请先取消归档。', 'An archived conversation cannot be pinned; unarchive it first.') })
      }
      return runWrite({
        key: 'pin:' + id,
        method: 'workspace.pinSession',
        payload: { sessionId: id },
        verify: value => applyPinResult(value, id, 'pin'),
        apply: verified => { host.pinned = new Set(verified.pinnedSessionIds) },
        reconcile: () => reconcileSet('pin', id, true),
        successMessage: text('已置顶，主机已保存；官方 DSH 和其他 Remote 重新加载后可见。', 'Pinned on the Host; official DSH and other Remote clients see it after reload.'),
        refreshScope: 'workspaces',
        resultExtra: { sessionId: id },
      })
    }

    async function unpin(sessionId) {
      const readOnly = requireWritable(); if (readOnly) return readOnly
      const missing = requireSession(sessionId); if (missing) return missing
      const id = String(sessionId)
      if (!host.pinned.has(id)) return success({ noop: true, method: 'workspace.unpinSession' })
      return runWrite({
        key: 'unpin:' + id,
        method: 'workspace.unpinSession',
        payload: { sessionId: id },
        verify: value => applyPinResult(value, id, 'unpin'),
        apply: verified => { host.pinned = new Set(verified.pinnedSessionIds) },
        reconcile: () => reconcileSet('pin', id, false),
        successMessage: text('已取消置顶，主机已保存。', 'Unpinned on the Host.'),
        refreshScope: 'workspaces',
        resultExtra: { sessionId: id },
      })
    }

    async function unarchive(sessionId) {
      const readOnly = requireWritable(); if (readOnly) return readOnly
      const missing = requireSession(sessionId); if (missing) return missing
      const id = String(sessionId)
      if (!host.archived.has(id)) return success({ noop: true, method: 'workspace.unarchiveSession' })
      return runWrite({
        key: 'unarchive:' + id,
        method: 'workspace.unarchiveSession',
        payload: { sessionId: id },
        verify: value => applyUnarchiveResult(value, id),
        apply: verified => { host.archived = new Set(verified.archivedSessionIds) },
        reconcile: () => reconcileSet('archive', id, false),
        successMessage: text('已取消归档，会话回到正常列表；主机已保存。', 'Unarchived on the Host; the conversation is back in the normal list.'),
        refreshScope: 'sessions',
        resultExtra: { sessionId: id },
      })
    }

    async function renameWorkspace(workspaceId, rawTitle) {
      const readOnly = requireWritable(); if (readOnly) return readOnly
      const id = String(workspaceId == null ? '' : workspaceId)
      const workspace = host.workspaces.find(item => item.workspaceId === id)
      if (!workspace) return failure({ kind: KIND.NOT_FOUND, ambiguous: false, message: text('工作区不存在，可能已被移除。', 'The workspace does not exist; it may have been removed.') })
      const validation = validateWorkspaceTitle(rawTitle, { workspaces: host.workspaces, currentWorkspaceId: id })
      if (!validation.ok) return failure({ kind: validation.error === 'conflict' ? KIND.CONFLICT : KIND.FAILED, ambiguous: false, code: validation.error, message: validation.message })
      return runWrite({
        key: 'rename:' + id,
        method: 'workspace.rename',
        payload: { workspaceId: id, title: validation.title },
        verify: value => applyRenameResult(value, id, validation.title),
        apply: verified => {
          const row = normalizeWorkspace(verified.workspace)
          host.workspaces = host.workspaces.map(item => item.workspaceId === id ? row : item)
        },
        reconcile: async () => {
          const refreshed = await refreshHost('workspaces')
          if (!refreshed) return { ok: false, reason: 'cannot-verify' }
          return { ok: !!host.workspaces.find(item => item.workspaceId === id && item.title === validation.title), reason: 'read-back' }
        },
        successMessage: text('工作区名称已更新，主机已保存。', 'Workspace name updated on the Host.'),
        refreshScope: 'workspaces',
        resultExtra: { workspaceId: id, title: validation.title },
      })
    }

    function getWorkspaceImpact(workspaceId) {
      const workspace = host.workspaces.find(item => item.workspaceId === String(workspaceId || ''))
      if (!workspace) return null
      return workspaceImpact(workspace, host.sessions, {
        archivedSessionIds: [...host.archived],
        pinnedSessionIds: [...host.pinned],
        titleOf: adapter.titleOf,
      })
    }

    async function removeWorkspace(workspaceId, options = {}) {
      const readOnly = requireWritable(); if (readOnly) return readOnly
      const id = String(workspaceId == null ? '' : workspaceId)
      const workspace = host.workspaces.find(item => item.workspaceId === id)
      if (!workspace) return failure({ kind: KIND.NOT_FOUND, ambiguous: false, message: text('工作区不存在，可能已被移除。', 'The workspace does not exist; it may have been removed.') })
      const impact = getWorkspaceImpact(id)
      const request = removeWorkspaceConfirmation(workspace, impact)
      if (options.confirm !== false && options.confirmed !== true) {
        if (typeof adapter.confirm !== 'function') {
          return failure({ kind: KIND.CONFIRMATION_UNAVAILABLE, ambiguous: false, message: text('缺少移除确认，操作未执行。', 'No removal confirmation is available; nothing was removed.') })
        }
        const approved = await adapter.confirm(request)
        if (!approved) return failure({ kind: KIND.CANCELLED, ambiguous: false, message: text('已取消移除。', 'Removal cancelled.') })
      }
      return runWrite({
        key: 'delete:' + id,
        method: 'workspace.delete',
        payload: { workspaceId: id },
        verify: value => applyDeleteResult(value),
        apply: () => { host.workspaces = host.workspaces.filter(item => item.workspaceId !== id) },
        reconcile: async () => {
          const refreshed = await refreshHost('workspaces')
          if (!refreshed) return { ok: false, reason: 'cannot-verify' }
          return { ok: !host.workspaces.some(item => item.workspaceId === id), reason: 'read-back' }
        },
        successMessage: text(`已移除工作区登记「${workspace.name}」；会话与磁盘文件均未删除。`, `Removed the workspace registration "${workspace.name}"; conversations and files on disk were not deleted.`),
        refreshScope: 'workspaces',
        resultExtra: { workspaceId: id, impact },
      })
    }

    const manager = {
      hydrate,
      getState: snapshot,
      canWrite: writable,
      isPinned: sessionId => host.pinned.has(String(sessionId == null ? '' : sessionId)),
      isArchived: sessionId => host.archived.has(String(sessionId == null ? '' : sessionId)),
      pin,
      unpin,
      unarchive,
      renameWorkspace,
      removeWorkspace,
      getWorkspaceImpact,
      validateWorkspaceTitle: (rawValue, workspaceId) => validateWorkspaceTitle(rawValue, { workspaces: host.workspaces, currentWorkspaceId: workspaceId || '' }),
      get workspaces() { return host.workspaces.map(item => ({ ...item, sessionIds: item.sessionIds.slice() })) },
      adapter,
    }
    hydrate()
    return manager
  }

  function workspaceRowHtml(workspace, state) {
    const disabled = state.canWrite ? '' : ' disabled'
    const count = workspace.sessionIds.length
    return `<li class="dr-session-admin-workspace" data-dr-session-admin-workspace="${esc(workspace.workspaceId)}">
      <div class="dr-session-admin-workspace-info">
        <span class="dr-session-admin-workspace-name">${esc(workspace.name)}</span>
        <span class="dr-session-admin-workspace-path" title="${esc(workspace.path)}">${esc(workspace.path)}</span>
        <span class="dr-session-admin-workspace-count">${esc(text(`${count} 个会话`, `${count} ${count === 1 ? 'conversation' : 'conversations'}`))}</span>
      </div>
      <div class="dr-session-admin-workspace-actions">
        <button type="button" class="dr-session-admin-btn" data-dr-session-admin-action="rename-workspace" data-workspace-id="${esc(workspace.workspaceId)}"${disabled}>${esc(text('重命名', 'Rename'))}</button>
        <button type="button" class="dr-session-admin-btn dr-session-admin-btn-danger" data-dr-session-admin-action="remove-workspace" data-workspace-id="${esc(workspace.workspaceId)}"${disabled}>${esc(text('移除登记', 'Remove registration'))}</button>
      </div>
    </li>`
  }

  /** Markup for the workspace management section (rename + registration removal). */
  function renderWorkspaceAdminHtml(state = {}) {
    const workspaces = Array.isArray(state.workspaces) ? state.workspaces : []
    const rows = workspaces.length
      ? `<ul class="dr-session-admin-workspaces">${workspaces.map(workspace => workspaceRowHtml(workspace, state)).join('')}</ul>`
      : `<div class="dr-session-admin-empty">${esc(text('没有已登记的工作区。', 'No registered workspaces.'))}</div>`
    const readOnly = state.canWrite === false
      ? `<div class="dr-session-admin-readonly" role="note">${esc(text('只读/配对设备：不能重命名或移除工作区，也不会写入主机状态。', 'Read-only/paired device: rename and removal are disabled and nothing is written to the Host.'))}</div>`
      : ''
    return `<section class="dr-session-admin" data-dr-session-admin>
      <div class="dr-session-admin-head">
        <strong class="dr-session-admin-title">${esc(text('工作区管理', 'Workspace management'))}</strong>
        <span class="dr-session-admin-hint">${esc(text('重命名与移除都写入主机；移除只删除登记，不删除磁盘目录、文件或会话历史。', 'Rename and removal are written to the Host. Removal deletes the registration only, not directories, files or conversation history on disk.'))}</span>
      </div>
      ${readOnly}
      ${rows}
    </section>`
  }

  /** Markup for per-session pin/unpin/unarchive actions. */
  function renderSessionAdminActions(session, state = {}) {
    if (!session || !session.sessionId) return ''
    const sessionId = String(session.sessionId)
    const archived = state.archivedSessionIds ? state.archivedSessionIds.map(String).includes(sessionId) : false
    const pinned = state.pinnedSessionIds ? state.pinnedSessionIds.map(String).includes(sessionId) : false
    const disabled = state.canWrite === false ? ' disabled' : ''
    const buttons = []
    if (archived) {
      buttons.push(`<button type="button" class="dr-session-admin-btn" data-dr-session-admin-action="unarchive-session" data-session-id="${esc(sessionId)}"${disabled}>${esc(text('取消归档', 'Unarchive'))}</button>`)
    } else {
      buttons.push(pinned
        ? `<button type="button" class="dr-session-admin-btn is-active" data-dr-session-admin-action="unpin-session" data-session-id="${esc(sessionId)}"${disabled}>${esc(text('取消置顶', 'Unpin'))}</button>`
        : `<button type="button" class="dr-session-admin-btn" data-dr-session-admin-action="pin-session" data-session-id="${esc(sessionId)}"${disabled}>${esc(text('置顶', 'Pin'))}</button>`)
    }
    return `<span class="dr-session-admin-actions" data-dr-session-admin-actions data-session-id="${esc(sessionId)}">${buttons.join('')}</span>`
  }

  function bindWorkspaceAdmin(panel, manager, options = {}) {
    if (!panel || typeof panel.addEventListener !== 'function') return () => {}
    const redraw = () => {
      try { if (typeof options.render === 'function') options.render() } catch {}
    }
    const onClick = async event => {
      const target = event.target && event.target.closest ? event.target : null
      if (!target) return
      const control = target.closest('[data-dr-session-admin-action]')
      if (!control || !control.dataset) return
      const action = control.dataset.drSessionAdminAction
      let result = null
      if (action === 'rename-workspace') {
        const workspace = manager.workspaces.find(item => item.workspaceId === control.dataset.workspaceId)
        if (!workspace) return
        let title = workspace.title
        if (typeof options.promptTitle === 'function') {
          title = await options.promptTitle({ workspace, current: workspace.title })
          if (title == null) return
        } else if (typeof manager.adapter.promptTitle === 'function') {
          title = await manager.adapter.promptTitle({ workspace, current: workspace.title })
          if (title == null) return
        }
        result = await manager.renameWorkspace(workspace.workspaceId, title)
      } else if (action === 'remove-workspace') {
        result = await manager.removeWorkspace(control.dataset.workspaceId)
      } else if (action === 'pin-session' || action === 'unpin-session' || action === 'unarchive-session') {
        const sessionId = control.dataset.sessionId
        result = action === 'pin-session' ? await manager.pin(sessionId)
          : action === 'unpin-session' ? await manager.unpin(sessionId)
            : await manager.unarchive(sessionId)
      }
      if (result) {
        try { if (typeof options.onResult === 'function') options.onResult(result, action) } catch {}
        redraw()
      }
    }
    panel.addEventListener('click', onClick)
    return () => panel.removeEventListener('click', onClick)
  }

  function mountWorkspaceAdmin(container, manager, options = {}) {
    const doc = options.document || root.document
    if (!container || !doc || typeof doc.createElement !== 'function') return null
    const element = doc.createElement('div')
    element.className = 'dr-session-admin-host'
    container.appendChild(element)
    let destroyed = false
    const paint = () => {
      if (destroyed) return
      element.innerHTML = renderWorkspaceAdminHtml(manager.getState())
    }
    paint()
    const unbind = bindWorkspaceAdmin(element, manager, { ...options, render: paint })
    return {
      element,
      refresh: paint,
      destroy() { destroyed = true; unbind(); if (element.parentNode) element.parentNode.removeChild(element) },
    }
  }

  const api = {
    kinds: KIND,
    esc,
    text,
    normalizeWorkspace,
    sessionTitle,
    sessionBelongsToWorkspace,
    workspaceImpact,
    validateWorkspaceTitle,
    applyPinResult,
    applyUnarchiveResult,
    applyRenameResult,
    applyDeleteResult,
    classifyManagementError,
    removeWorkspaceConfirmation,
    createManager,
    init: adapter => {
      const manager = createManager(adapter)
      instance = manager
      return manager
    },
    renderWorkspaceAdminHtml,
    renderSessionAdminActions,
    bindWorkspaceAdmin,
    mountWorkspaceAdmin,
    get instance() { return instance },
  }
  let instance = null
  Object.defineProperty(api, 'manager', { get: () => instance })
  root.DshSessionManagement = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
