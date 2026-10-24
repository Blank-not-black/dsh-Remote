'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const modulePromise = import('../scripts/android-version.mjs')

test('Android release counter advances across rc.10, 0.10.x and 1.x without decimal slots', async () => {
  const { androidVersion, releaseAndroidVersion } = await modulePromise
  const pkg = { version: '0.8.0-rc.9', androidVersionCode: 8009 }
  for (const version of ['0.8.0-rc.10', '0.8.0-rc.1000', '0.8.0', '0.9.0', '0.10.0-rc.1', '0.10.0', '0.10.1000', '1.0.0-rc.1', '1.0.0', '21.100.1000']) {
    const value = releaseAndroidVersion(pkg, version)
    assert.equal(value.versionCode, pkg.androidVersionCode + 1)
    assert.equal(value.versionName, version.replace('-', '.'))
    Object.assign(pkg, { version, androidVersionCode: value.versionCode })
    assert.equal(releaseAndroidVersion(pkg, version).versionCode, pkg.androidVersionCode, 'same release retries must be idempotent')
  }
  assert.deepEqual(releaseAndroidVersion({version:'0.8.0-rc.9',androidVersionCode:8009},'0.8.0'), {versionName:'0.8.0',versionCode:8010})
  assert.equal(androidVersion('0.10.0', 8010).versionCode, 8010)
})

test('invalid or exhausted counters fail before a release can generate Android metadata', async () => {
  const { androidVersion, releaseAndroidVersion } = await modulePromise
  for (const code of [undefined, null, '8009', 0, -1, 1.5, NaN, Infinity, 2100000001]) assert.throws(() => androidVersion('0.8.0', code), /androidVersionCode/)
  for (const version of ['0.8.0-rc.0', '0.8.0-beta.1', '0.8.0+build', '00.8.0', '0.8.0\n']) assert.throws(() => androidVersion(version, 8009), /Invalid Android/)
  const pkg = { version: '0.8.0-rc.9', androidVersionCode: 2100000000 }
  assert.equal(releaseAndroidVersion(pkg,pkg.version).versionCode, 2100000000)
  assert.throws(() => releaseAndroidVersion(pkg,'0.8.0'), /androidVersionCode/)
})

test('Gradle consumes the explicit version code through the tested CLI', async () => {
  const { androidVersion } = await modulePromise
  const script = path.join(__dirname, '../scripts/android-version.mjs')
  const result = spawnSync(process.execPath, [script, '0.8.0', '8010'], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), androidVersion('0.8.0',8010))
  const invalid = spawnSync(process.execPath, [script, '0.8.0', ''], { encoding: 'utf8', windowsHide: true })
  assert.notEqual(invalid.status, 0)
  assert.equal(invalid.stdout, '')
  const gradle = fs.readFileSync(path.join(__dirname, '../android/app/build.gradle'), 'utf8')
  assert.match(gradle, /commandLine 'node', 'scripts\/android-version\.mjs', dshPkg\.version, dshPkg\.androidVersionCode\.toString\(\)/)
  assert.match(gradle, /versionCode dshAndroidVersion\.versionCode/)
  assert.match(gradle, /versionName dshAndroidVersion\.versionName/)
})
