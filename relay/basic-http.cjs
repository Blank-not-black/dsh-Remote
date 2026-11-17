'use strict'
const { Transform } = require('node:stream')
const { fault } = require('./registry.cjs')
const { basicPolicy } = require('./basic-policy.cjs')

const MIB = 1024 * 1024
const REQUEST_LIMIT = 16 * MIB
const RESPONSE_LIMIT = 24 * MIB
const UPDATE_LIMIT = 64 * MIB

const RPC = new Set(`
  agentPresets.list permissionPresets.catalog skills.list host.describe
  session.list session.history session.models session.search session.create session.delete
  session.selectModel session.rename session.fork session.prompt session.attachment
  session.updateQueue session.cancel session.getModels session.getQueue session.getCompactionStatus
  workspace.list workspace.create workspace.rename workspace.delete workspace.insertBefore
  workspace.insertSessionBefore workspace.archiveSession
  goal.create goal.edit goal.pause goal.resume goal.complete goal.clear
  subagent.list subagent.interrupt settings.describe settings.mutate settings.openDocument
  credentials.describe credentials.set credentials.unset llm.providers llm.discoverModels
`.trim().split(/\s+/))
const OPERATIONS = new Set(`
  session.fork session.create session.prompt session.updateQueue session.selectModel
  session.rename session.cancel workspace.create workspace.archiveSession
  goal.edit goal.pause goal.resume goal.complete goal.clear
`.trim().split(/\s+/))
const READ_ROUTES = new Set(`
  /health /diagnostics /crash-logs /handoff /relay /relay/e2ee /workbench
  /api/operations /api/events.poll /stats/summary /stats/detail
  /remote/api/host-description /remote/api/insights/cost /remote/api/insights/peak-reminders
  /remote/api/doctor/target /remote/api/command /remote/api/command-status /remote/api/teams /remote/api/task-board
  /remote/api/skills/list /remote/api/skills/read
  /remote/api/plugins/state /remote/api/plugins/details /remote/api/plugins/readme
  /remote/api/plugins/market /remote/api/plugins/market/indexes
  /admin/api/state /admin/api/runtime /admin/api/autostart /admin/api/lan /admin/api/dsh
  /admin/api/relay /admin/api/relay/e2ee
  /remote/admin/api/state /remote/admin/api/autostart /remote/admin/api/lan /remote/admin/api/dsh
  /remote/admin/api/relay /remote/admin/api/config /remote/admin/api/cost
  /remote/admin/api/stats/summary /remote/admin/api/stats/detail /remote/admin/api/doctor-target
`.trim().split(/\s+/))
const WRITE_ROUTES = new Set(`
  /api/operations /api/respond /api/ws-ticket /api/lan-pair
  /relay /relay/e2ee /relay/pair /feedback /workbench/bind /workbench/unbind
  /remote/api/command /remote/api/approval-summary
  /remote/api/plugins/operations /remote/api/plugins/preflight /remote/api/plugins/recover
  /admin/api/dsh /admin/api/relay /admin/api/relay/e2ee /admin/api/relay/pair
  /admin/api/lan /admin/api/autostart /admin/api/token/rotate /admin/api/shutdown
  /admin/api/upstream /admin/api/note /admin/api/kick
  /admin/api/device-keys/mode /admin/api/device-keys/create /admin/api/device-keys/note
  /admin/api/device-keys/rotate /admin/api/device-keys/revoke
  /remote/admin/api/config /remote/admin/api/gateway /remote/admin/api/dsh
  /remote/admin/api/relay /remote/admin/api/autostart /remote/admin/api/lan /remote/admin/api/browser-launch
`.trim().split(/\s+/))
const WEB_ASSETS = new Set(`
  index.html admin.html plugin.html manifest.webmanifest icon.svg plugin-icon.svg donate.png
  announcements.json build.json update.json version.json harmonyos-update.json
  activity.js admin.js announcement-forms.js app.js approval-records.js approval-summary.js
  cache-upgrade.js chat-copy.js chat-files.js diagnostics.js doctor-entry.js doctor.js
  e2ee-transport.js extensions.js file-inbox.js genui.js history.js i18n.js
  image-cache.js image-preview.js insights.js jsqr.min.js lan-discovery.js link-check.js md.js
  morphicons-init.js motion.js network.js onboarding.js operations.js permission-presets.js
  plugin-center.js plugin.js qrcode.min.js relay-autopair.js relay-devices.js relay-settings.js
  remote-state.js remote-ui.js session-deck.js session-presets.js setup.js sha256.js skills.js
  slash-suggestions.js sponsor-entry.js subagents.js task-board.js teams.js theme.js transcribe-core.js
  turn-results.js workflow.js desktop/desktop.js desktop/i18n.js
  desktop/desktop.css desktop/desktop.html doctor.css extensions.css file-inbox.css genui.css
  insights.css onboarding.css plugin-center.css relay-settings.css remote-ui.css session-deck.css
  setup.css skills.css slash-suggestions.css styles.css subagents.css theme-picker.css
  theme-vars.css workflow.css vendor/gsap/gsap.min.js vendor/gsap/NOTICE.md
  vendor/morphicons/LICENSE vendor/morphicons/README.md
`.trim().split(/\s+/))
const UPDATE_ASSETS = new Set(['dsh-remote.apk', 'dsh-remote-harmonyos.hap', 'dsh-remote-harmonyos-unsigned.hap'])

function basicHttp(req) {
  // Decide on the exact path that will go on the wire. Do not authorize a
  // normalized alias and then forward the original path to a different router.
  const route = req.url.split('?', 1)[0]
  if (!/^\/[A-Za-z0-9_./-]*$/.test(route) || route.includes('//') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(route)) {
    throw fault('FILE_TRANSFER_NOT_ALLOWED', 403)
  }
  const mode = basicPolicy(req)
  const image = mode === 'attachment' && req.method !== 'POST' ? null : mode
  const read = READ_ROUTES.has(route)
  const write = WRITE_ROUTES.has(route) || route.startsWith('/api/') && RPC.has(route.slice(5))
  const readMethod = req.method === 'GET' || req.method === 'HEAD'
  const asset = route.replace(/^\/(?:remote(?:\/|$))?/, '')
  const skin = /^skins\/[a-z0-9-]+\/[a-zA-Z0-9_.-]+\.(?:png|svg|css|js|html|webp|json|md)$/.test(asset)
  const iconScript = /^vendor\/morphicons\/[A-Za-z0-9_.-]+\.js$/.test(asset)
  const page = ['', 'admin', 'admin/', 'desktop', 'desktop/'].includes(asset) || WEB_ASSETS.has(asset) || skin || iconScript
  const update = UPDATE_ASSETS.has(asset)
  const handoff = route === '/handoff' && ['PUT', 'DELETE'].includes(req.method)
  const api = read || write
  const allowedApi = (read && readMethod) || (write && req.method === 'POST') || (api && req.method === 'OPTIONS') || handoff
  if (!image && !allowedApi && !(readMethod && (page || update))) {
    throw fault('RELAY_ROUTE_NOT_ALLOWED', 403)
  }
  const requestBytes = req.method === 'POST' || req.method === 'PUT' ? REQUEST_LIMIT : 0
  if (Number(req.headers['content-length']) > requestBytes || (!requestBytes && req.headers['transfer-encoding'])) {
    throw fault('BODY_TOO_LARGE', 413)
  }
  return { image, api, route, requestBytes, responseBytes: update ? UPDATE_LIMIT : RESPONSE_LIMIT }
}

function validateOperation(route, body) {
  if (route === '/api/operations' && body !== null && !OPERATIONS.has(JSON.parse(body.toString('utf8'))?.method)) {
    throw fault('RELAY_ROUTE_NOT_ALLOWED', 403)
  }
}

function validateResponse(req, response, policy) {
  if (req.method === 'HEAD' || response.statusCode === 204 || response.statusCode === 304) return
  if (Number(response.headers['content-length']) > policy.responseBytes) {
    throw fault('RELAY_RESPONSE_TOO_LARGE', 502)
  }
  if (policy.api && response.statusCode >= 200 && response.statusCode < 300) {
    const type = String(response.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
    if (type !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(type)) throw fault('RELAY_RESPONSE_TYPE_NOT_ALLOWED', 502)
  }
}

class ByteLimit extends Transform {
  constructor(maxBytes, code, status) {
    super()
    this.remaining = maxBytes
    this.code = code
    this.status = status
  }
  _transform(chunk, encoding, done) {
    this.remaining -= chunk.length
    if (this.remaining < 0) return done(fault(this.code, this.status))
    done(null, chunk)
  }
}

module.exports = { basicHttp, validateOperation, validateResponse, ByteLimit }
