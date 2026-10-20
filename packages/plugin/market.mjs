/* Read-only facade over DSH's official market. No index fetcher or ranking here. */
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const versionName = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/
const text = (value, max = 300) => typeof value === 'string' ? value.slice(0, max) : ''
function localized(value) {
  if (typeof value === 'string') return text(value)
  return Object.fromEntries(Object.entries(value || {}).filter(([key, val]) => /^[a-z]{2}(?:-[A-Za-z]{2,4})?$/.test(key) && typeof val === 'string').slice(0, 8).map(([key, val]) => [key, text(val)]))
}
function safeUrl(value) {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password && value.length <= 2048 ? url.href : '' } catch { return '' }
}
async function bounded(task, ms) {
  let timer
  try { return await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), ms) })]) } finally { clearTimeout(timer) }
}
function validQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['text','category','labels','sort','offset','limit','fetchedAt','refresh'].includes(key))) return false
  if (query.text != null && (typeof query.text !== 'string' || query.text.length > 80)) return false
  if (query.category != null && (typeof query.category !== 'string' || query.category.length > 100)) return false
  if (query.labels != null && (!Array.isArray(query.labels) || query.labels.length > 20 || query.labels.some(v => typeof v !== 'string' || v.length > 100))) return false
  if (!Number.isSafeInteger(query.offset) || query.offset < 0 || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) return false
  if (query.fetchedAt != null && (!Number.isSafeInteger(query.fetchedAt) || query.fetchedAt < 0) || query.refresh != null && typeof query.refresh !== 'boolean') return false
  const sort = query.sort
  if (!sort || typeof sort !== 'object' || Array.isArray(sort)) return false
  if (['index','relevance'].includes(sort.kind)) return Object.keys(sort).length === 1
  if (!['published','key'].includes(sort.kind) || !['asc','desc'].includes(sort.direction)) return false
  return sort.kind === 'published' ? Object.keys(sort).length === 2 : Object.keys(sort).length === 3 && typeof sort.id === 'string' && !!sort.id && sort.id.length <= 100
}
export function createMarketAdapter(ctx, { timeoutMs = 20000 } = {}) {
  function service() { try { return ctx.get?.('pluginMarket') } catch {} }
  async function indexes() {
    const host = service()
    const base = { ok: true, source: 'official', indexes: [] }
    if (!host) return { ...base, available: false, code: 'not-installed' }
    if (typeof host.listIndexes !== 'function' || typeof host.search !== 'function') return { ...base, available: false, code: 'unsupported' }
    try {
      const rows = await bounded(Promise.resolve().then(() => host.listIndexes()), timeoutMs)
      if (!Array.isArray(rows) || rows.length > 100) throw Error('unsupported')
      return { ...base, available: true, indexes: rows.map(row => ({ url: safeUrl(row.url), title: localized(row.title), description: localized(row.description), ...(row.error || !safeUrl(row.url) ? { code: 'index-unavailable' } : {}) })) }
    } catch { return { ...base, available: false, code: 'market-unavailable' } }
  }
  async function search(url, query) {
    const empty = { ok: true, available: false, source: 'official', items: [], total: 0, nextOffset: null }
    if (!validQuery(query)) return { ...empty, ok: false, code: 'invalid-query' }
    const state = await indexes()
    if (!state.available) return { ...empty, code: state.code }
    const index = url ? state.indexes.find(row => row.url === url) : state.indexes.find(row => !row.code)
    if (!index) return { ...empty, code: state.indexes.length ? 'unknown-index' : 'no-indexes' }
    if (index.code) return { ...empty, code: 'index-unavailable' }
    try {
      const result = await bounded(Promise.resolve().then(() => service().search(index.url, query)), timeoutMs)
      if (!Array.isArray(result.entries)) throw Error('invalid response')
      const categories = Object.entries(result.metadata?.categories || {}).slice(0, 100).map(([id, row]) => ({ id: text(id, 100), title: localized(row.title) }))
      const items = result.entries.slice(0, query.limit).filter(row => packageName.test(row.name)).map(row => {
        const versions = Array.isArray(row.versions) ? row.versions : [], selected = versions.find(v => v.version === row.defaultVersion) || versions[0] || {}
        return { name: row.name, version: text(selected.version, 100), title: localized(row.title), description: localized(row.description), author: text(row.author), homepage: safeUrl(row.homepage), repository: { url: safeUrl(row.repository?.url), directory: text(row.repository?.directory) }, category: text(row.metadata?.category, 100), versionCount: versions.length,
          installSupported: selected.source?.type === 'npm' && (!selected.source.registry || safeUrl(selected.source.registry).replace(/\/$/, '') === 'https://registry.npmjs.org'),
          installation: { status: ['not-installed','installed','update-available','different-version','provided'].includes(row.installation?.status) ? row.installation.status : 'unknown', installedVersion: text(row.installation?.installedVersion, 100) },
          compatibility: typeof selected.compatibility?.compatible === 'boolean' ? { compatible: selected.compatibility.compatible, runtimeVersion: text(selected.compatibility.runtimeVersion, 100), requirements: { 'engines.dsh': text(selected.compatibility.requirements?.['engines.dsh'], 100) } } : null }
      })
      return { ok: true, available: true, source: 'official', index: { ...index, title: localized(result.title), description: localized(result.description) }, categories, items, total: Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : items.length, nextOffset: Number.isSafeInteger(result.nextOffset) && result.nextOffset > query.offset ? result.nextOffset : null, fetchedAt: Number.isSafeInteger(result.fetchedAt) ? result.fetchedAt : null }
    } catch { return { ...empty, code: 'market-unavailable' } }
  }
  return { indexes, search }
}

export function createReadmeReader(registry) {
  const cache = new Map()
  return async (name, version = '') => {
    if (!packageName.test(name) || version && !versionName.test(version)) return { ok: false, code: 'invalid-name' }
    try {
      let record = cache.get(name)
      if (!record || record.until < Date.now()) {
        const data = await registry('/' + encodeURIComponent(name))
        if (data.name !== name) throw Error('invalid package')
        const content = typeof data.readme === 'string' ? data.readme : ''
        record = { until: Date.now() + 600000, value: content.trim() ? { ok: true, available: true, source: 'npm', content: content.slice(0, 100000), truncated: content.length > 100000, version: versionName.test(data['dist-tags']?.latest || '') ? data['dist-tags'].latest : '', versionBasis: 'dist-tag:latest' } : { ok: true, available: false, code: 'no-readme' } }
        cache.set(name, record); if (cache.size > 30) cache.delete(cache.keys().next().value)
      }
      return { ...record.value }
    } catch { return { ok: false, code: 'readme-unavailable' } }
  }
}
