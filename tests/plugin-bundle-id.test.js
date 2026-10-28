'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const PLUGIN = path.join(__dirname, '..', 'packages', 'plugin')
const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'))
const body = fs
  .readFileSync(path.join(PLUGIN, 'cordis.patch.yml'), 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n')

test('bundle patch 的 entry id 与包名一致, 不与通用 id 的插件互相顶替', () => {
  const id = body.match(/^\s*-\s*id:\s*['"]?([^'"\s]+)['"]?/m)?.[1]
  const name = body.match(/^\s*name:\s*['"]?([^'"\s]+)['"]?/m)?.[1]
  assert.equal(id, pkg.name)
  assert.equal(name, pkg.name)
  assert.equal([...body.matchAll(/^\s*-\s*id:/gm)].length, 1)
})
