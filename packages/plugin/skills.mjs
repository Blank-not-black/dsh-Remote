// Read-only adapter for dsh-skill-explorer 0.4.x. Paths never come from clients.
import { createHash } from 'node:crypto'
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : ''
const idOf = (name, path, source) => createHash('sha256').update(JSON.stringify([name, path, source])).digest('hex')
const unavailable = code => ({ status: 200, body: { ok: true, available: false, code } })
export function createSkillsAdapter(requestNative) {
  async function list() {
    const raw = await requestNative('/api/dsh-skill-explorer/list')
    if (!raw || !Array.isArray(raw.groups) || typeof raw.complete !== 'boolean') throw new Error('unsupported')
    const items = [], identities = new Map()
    let truncated = raw.groups.length > 50
    for (const group of raw.groups.slice(0, 50)) {
      if (!Array.isArray(group?.skills)) throw new Error('unsupported')
      for (const row of group.skills) {
        if (items.length >= 500) { truncated = true; break }
        if (!row || typeof row.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.name) || row.name.length > 200) continue
        const source = text(group.key, 100), path = text(row.path, 4096), id = idOf(row.name, path, source)
        const item = { id, name: row.name, description: text(row.description, 3000), whenToUse: text(row.whenToUse, 3000), source,
          modelInvocable: typeof row.modelInvocable === 'boolean' ? row.modelInvocable : null,
          userInvocable: typeof row.userInvocable === 'boolean' ? row.userInvocable : null,
          readable: !!path, workspace: text(row.workspaceName, 200) }
        identities.set(id, { name: row.name, path, item }); items.push(item)
      }
    }
    return { body: { ok: true, schema: 1, available: true, source: 'dsh-skill-explorer', complete: raw.complete, truncated,
      generatedAt: Date.now(), items }, identities }
  }
  return { async handle(method, endpoint, query = new URLSearchParams()) {
    if (method !== 'GET') return { status: 405, body: { ok: false, code: 'read-only' } }
    if (!['/list', '/read'].includes(endpoint)) return { status: 404, body: { ok: false, code: 'unknown-route' } }
    const keys = [...query.keys()]
    if (endpoint === '/list' ? keys.length : keys.length !== 1 || keys[0] !== 'id' || !/^[a-f0-9]{64}$/.test(query.get('id') || '')) {
      return { status: 400, body: { ok: false, code: 'invalid-query' } }
    }
    try {
      const state = await list()
      if (endpoint === '/list') return { status: 200, body: state.body }
      const found = state.identities.get(query.get('id'))
      if (!found) return { status: 409, body: { ok: false, code: 'skill-changed' } }
      if (!found.path) return { status: 200, body: { ok: true, available: true, item: found.item, content: null } }
      const params = new URLSearchParams({ name: found.name, path: found.path })
      const detail = await requestNative('/api/dsh-skill-explorer/read?' + params)
      if (!detail || detail.name !== found.name || detail.path !== found.path || typeof detail.content !== 'string') throw new Error('unsupported')
      return { status: 200, body: { ok: true, available: true, item: found.item,
        content: detail.content.slice(0, 100000), truncated: detail.content.length > 100000 } }
    } catch (error) {
      if (error.status === 404) return unavailable('not-installed')
      if (error.status === 401 || error.status === 403) return { status: 502, body: { ok: false, code: 'host-denied' } }
      if (error.status === 409) return { status: 409, body: { ok: false, code: 'skill-changed' } }
      return { status: 502, body: { ok: false, code: error.message === 'unsupported' ? 'unsupported' : 'skills-unavailable' } }
    }
  } }
}
