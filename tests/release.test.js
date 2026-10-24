const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

test('standalone and npm distributions include every relative module imported by the plugin', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/sync-standalone.mjs'), 'utf8')
  const match = source.match(/for \(const name of (\[[^\]]+\])\) \{\s*cpSync\(join\(src, name\)/)
  assert.ok(match, 'standalone module copy list is present')
  const shipped = new Set(JSON.parse(match[1].replaceAll("'", '"')))
  const npmFiles = JSON.parse(fs.readFileSync(path.join(__dirname, '../packages/plugin/package.json'), 'utf8')).files
  const pending = ['index.mjs'], visited = new Set()
  while (pending.length) {
    const file = pending.pop()
    if (visited.has(file)) continue
    visited.add(file)
    assert.ok(shipped.has(file), 'standalone is missing ' + file)
    assert.ok(npmFiles.includes(file), 'npm files list is missing ' + file)
    const text = fs.readFileSync(path.join(__dirname, '../packages/plugin', file), 'utf8')
    for (const ref of text.matchAll(/\bfrom\s+['"](\.\/[^'"]+\.mjs)['"]/g)) {
      pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), ref[1])))
    }
  }
  assert.ok(visited.size > 1, 'the check traverses plugin module imports')
})

test('RC dry run synchronizes versions while CI-only release preserves existing APK metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-'))
  try {
    for (const dir of ['scripts', 'public', 'packages/plugin']) fs.mkdirSync(path.join(root, dir), { recursive: true })
    fs.copyFileSync(path.join(__dirname, '../scripts/release.mjs'), path.join(root, 'scripts/release.mjs'))
    fs.copyFileSync(path.join(__dirname, '../scripts/android-version.mjs'), path.join(root, 'scripts/android-version.mjs'))
    const write = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value))
    write('package.json', { version: '0.6.26', androidVersionCode: 6269, updateNotes: 'plugin center' })
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
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).androidVersionCode, 6270)
    const retry = spawnSync(process.execPath, ['scripts/release.mjs', '0.7.0-rc.1', '--dry-run', '--no-build'], { cwd: root, encoding: 'utf8', windowsHide: true })
    assert.equal(retry.status, 0, retry.stderr)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).androidVersionCode, 6270)
    const invalid = spawnSync(process.execPath, ['scripts/release.mjs', '0.7.0-rc.0', '--dry-run'], { cwd: root, encoding: 'utf8', windowsHide: true })
    assert.notEqual(invalid.status, 0)
    const exhausted = JSON.parse(fs.readFileSync(path.join(root, 'package.json')))
    exhausted.androidVersionCode = 2100000000
    write('package.json', exhausted)
    const files = ['package.json', 'packages/plugin/package.json', 'package-lock.json', 'public/version.json', 'public/update.json']
    const before = files.map(file => fs.readFileSync(path.join(root, file), 'utf8'))
    const overflow = spawnSync(process.execPath, ['scripts/release.mjs', '0.7.0', '--dry-run', '--no-build'], { cwd: root, encoding: 'utf8', windowsHide: true })
    assert.notEqual(overflow.status, 0)
    assert.deepEqual(files.map(file => fs.readFileSync(path.join(root, file), 'utf8')), before, 'an exhausted Android counter cannot partially bump release files')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
