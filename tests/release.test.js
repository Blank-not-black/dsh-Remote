const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

test('RC dry run synchronizes versions while CI-only release preserves existing APK metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-'))
  try {
    for (const dir of ['scripts', 'public', 'packages/plugin']) fs.mkdirSync(path.join(root, dir), { recursive: true })
    fs.copyFileSync(path.join(__dirname, '../scripts/release.mjs'), path.join(root, 'scripts/release.mjs'))
    const write = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value))
    write('package.json', { version: '0.6.26', updateNotes: 'plugin center' })
    write('packages/plugin/package.json', { version: '0.6.26' })
    write('package-lock.json', { version: '0.6.26', packages: { '': { version: '0.6.26' } } })
    const old = { version: '0.6.26', sha256: 'old-apk-hash', history: [] }
    write('public/update.json', old)
    const result = spawnSync(process.execPath, ['scripts/release.mjs', '0.7.0-rc.1', '--dry-run', '--no-build'], { cwd: root, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    for (const file of ['package.json', 'packages/plugin/package.json', 'package-lock.json', 'public/version.json']) {
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, file))).version, '0.7.0-rc.1')
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'public/update.json'))), old)
    const invalid = spawnSync(process.execPath, ['scripts/release.mjs', '0.7.0-rc.0', '--dry-run'], { cwd: root, encoding: 'utf8', windowsHide: true })
    assert.notEqual(invalid.status, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
