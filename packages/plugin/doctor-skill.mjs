// Bundled read-only diagnosis skill for DSH Remote.
// Registration is best-effort: an older DSH without the skill registry must
// still load the Remote plugin, and the client keeps a prompt-only fallback.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DOCTOR_SKILL_NAME = 'dsh-remote-doctor'
const SKILL_DIR = fileURLToPath(new URL('./skills/dsh-remote-doctor/', import.meta.url))
const SKILL_PATH = join(SKILL_DIR, 'SKILL.md')
const DESCRIPTION = 'Diagnose DSH Remote plugin and client problems with read-only evidence. Use when the user reports a DSH Remote connection, gateway, plugin update, mobile/desktop UI, notification, file-transfer, or model/session problem and asks for a cause analysis, troubleshooting steps, or an issue-ready feedback draft.'
const WHEN_TO_USE = 'The user is troubleshooting DSH Remote itself, wants evidence collected on their own machine, or asks whether a problem is a plugin defect.'
const PROVIDER = 'dsh-remote-doctor'
const BUNDLED_SKILL_RANK = 600

let body
const registrations = new WeakMap()
export const doctorSkillStatus = ctx => registrations.get(ctx) || 'unconfirmed'

function skillBody() {
  if (body !== undefined) return body
  const raw = readFileSync(SKILL_PATH, 'utf8').replace(/^\uFEFF/, '')
  body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
  if (!body) throw new Error('dsh-remote-doctor skill body is empty')
  return body
}

/**
 * Register the packaged doctor skill with the optional DSH skill registry.
 * Returns false instead of failing plugin startup when this DSH build has no
 * skill service or the packaged asset is unavailable.
 */
function registerProvider(ctx) {
  let skills
  try {
    // Cordis may reject access to an optional service before a method can be
    // tested. A missing/undeclared skill registry must not abort Remote.apply.
    skills = ctx?.get?.('skills') ?? ctx?.skills
    if (typeof skills?.registerProvider !== 'function' || typeof ctx?.effect !== 'function') return false
  } catch { return false }
  let content
  try {
    content = skillBody()
  } catch (error) {
    try { ctx.logger?.warn?.('dsh-remote: doctor skill unavailable: ' + (error?.message || String(error))) } catch {}
    return false
  }
  const candidate = {
    name: DOCTOR_SKILL_NAME,
    description: DESCRIPTION,
    whenToUse: WHEN_TO_USE,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER,
    source: 'bundled',
    path: SKILL_PATH,
    resourceBase: { kind: 'directory', path: SKILL_DIR },
    rank: BUNDLED_SKILL_RANK,
    locator: SKILL_PATH,
  }
  const provider = {
    name: PROVIDER,
    list: () => Promise.resolve([candidate]),
    get: () => Promise.resolve({
      name: DOCTOR_SKILL_NAME,
      description: DESCRIPTION,
      whenToUse: WHEN_TO_USE,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: PROVIDER,
      source: 'bundled',
      path: SKILL_PATH,
      resourceBase: { kind: 'directory', path: SKILL_DIR },
      content,
    }),
  }
  try {
    ctx.effect(() => skills.registerProvider(() => provider), 'dsh-remote: doctor skill')
    return true
  } catch (error) {
    try { ctx.logger?.warn?.('dsh-remote: doctor skill registration failed: ' + (error?.message || String(error))) } catch {}
    return false
  }
}

export function registerDoctorSkill(ctx) {
  // Optional injection declares service access and waits for the registry to
  // become available. True here means the watcher was installed; only the
  // observed registration status proves a provider was registered.
  if (typeof ctx?.inject === 'function') {
    registrations.set(ctx, 'waiting')
    ctx.inject(['skills'], child => {
      registrations.set(ctx, registerProvider(child) ? 'registered' : 'unavailable')
      child.effect(() => () => { registrations.set(ctx, 'waiting') }, 'dsh-remote: doctor registration state')
    })
    return true
  }
  const registered = registerProvider(ctx)
  registrations.set(ctx, registered ? 'registered' : 'unavailable')
  return registered
}
