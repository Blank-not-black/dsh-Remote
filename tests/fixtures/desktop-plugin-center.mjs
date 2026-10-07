import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPluginCenter, detectProfile } from '../../packages/plugin/plugin-center.mjs'

const [dir, cli] = process.argv.slice(2)
const host = join(dirname(cli), 'index.js'), runtimeDir = resolve(dirname(cli), '../../../..')
const ctx = { root: { baseUrl: pathToFileURL(dir + '/').href } }
const profile = detectProfile(ctx, host, { versions: process.versions, argv: [process.execPath, host, runtimeDir, dir] })
assert.equal(profile?.cli, cli); assert.equal(profile?.cliMode, 'desktop')
const center = createPluginCenter(ctx, { profile,
  details: async () => ({ bundle: true }) })
async function operation(action) {
  const state = await center.inventory(), id = randomUUID()
  await center.submit({ id, action, name: 'dsh-cost-meter', ...(['install', 'update'].includes(action) ? { version: '1.8.12' } : {}), revision: state.revision })
  for (let i = 0; i < 500; i++) {
    const state = await center.inventory(), job = state.operations.find(job => job.id === id)
    if (job && !['queued', 'running'].includes(job.phase)) {
      const startup = join(dir, '.remote-plugin-center', 'worker-' + id + '.log')
      assert.equal(job.phase, 'complete', job.message + '\n' + job.log + '\n' + (existsSync(startup) ? readFileSync(startup, 'utf8') : ''))
      assert.equal(state.busy, false); return state
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Desktop worker did not finish')
}
let state = await operation('install')
assert.equal(state.items.find(item => item.name === 'dsh-cost-meter').version, '1.8.12')
assert.equal(state.items.find(item => item.name === 'dsh-cost-meter').enabled, true)
state = await operation('disable'); assert.equal(state.items.find(item => item.name === 'dsh-cost-meter').enabled, false)
state = await operation('update'); assert.equal(state.items.find(item => item.name === 'dsh-cost-meter').enabled, false)
state = await operation('enable'); assert.equal(state.items.find(item => item.name === 'dsh-cost-meter').enabled, true)
state = await operation('remove'); assert.equal(state.items.some(item => item.name === 'dsh-cost-meter'), false)
assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), '[]\n')
console.log('Desktop carrier + real detached Electron worker: install/disable/update/enable/remove passed')
