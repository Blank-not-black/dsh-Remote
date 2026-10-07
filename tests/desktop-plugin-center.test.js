'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { spawn } = require('node:child_process'), { once } = require('node:events')

test('installed Desktop carrier runs isolated plugin lifecycle through real Electron workers', {
  skip: !process.env.DSH_TEST_DESKTOP_EXE || !process.env.DSH_TEST_DESKTOP_CLI, timeout: 90000,
}, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-plugin-center-'))
  const dir = path.join(home, '.dsh', 'profiles', 'desktop')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', private: true, dsh: { profile: { bundles: [] } } }))
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\n')
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/proxy|api[_-]?key|secret/i.test(key) || /^(TOKEN|TOKEN_FILE|DSH_|GATEWAY_|UPDATE_)/.test(key)) delete env[key]
  Object.assign(env, { HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh'), DSH_REMOTE_FS_ROOT: home,
    TOKEN: 'desktop-plugin-test-only', ELECTRON_RUN_AS_NODE: '1', npm_config_ignore_scripts: 'true' })
  const child = spawn(process.env.DSH_TEST_DESKTOP_EXE, ['--expose-internals', path.join(__dirname, 'fixtures/desktop-plugin-center.mjs'), dir, process.env.DSH_TEST_DESKTOP_CLI],
    { env, cwd: home, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill(); await done }
    const storage = path.join(dir, '.remote-plugin-center')
    for (const file of fs.existsSync(storage) ? fs.readdirSync(storage) : []) {
      if (!/^(lock|launch-.*)\.json$/.test(file)) continue
      const owner = JSON.parse(fs.readFileSync(path.join(storage, file)))
      for (const pid of [owner.pid, owner.workerPid, owner.cliPid]) if (pid) { try { process.kill(pid) } catch {} }
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  let logs = ''; for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => { logs += chunk })
  const [code] = await once(child, 'exit'); assert.equal(code, 0, logs)
  assert.match(logs, /install\/disable\/update\/enable\/remove passed/)
  t.diagnostic(logs.trim())
})
