'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const source = path.join(root, 'docs/wiki')
const bundled = path.join(root, 'packages/plugin/skills/dsh-remote-doctor/references/wiki')

test('the installed Doctor receives the entire current wiki without drift or stale pages', () => {
  const pages = fs.readdirSync(source).filter(name => name.endsWith('.md')).sort()
  assert.ok(pages.length >= 10, 'operations and symptom-specific runbooks must be present')
  assert.deepEqual(fs.readdirSync(bundled).sort(), pages)
  for (const name of pages) assert.equal(fs.readFileSync(path.join(bundled, name), 'utf8'), fs.readFileSync(path.join(source, name), 'utf8'), name)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'packages/plugin/package.json')))
  assert.ok(manifest.files.includes('skills'), 'npm package must carry offline references')
})

test('wiki navigation resolves in both the repository and the offline plugin', () => {
  for (const dir of [source, bundled]) {
    for (const name of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, name), 'utf8')
      for (const link of text.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(link[1])) continue
        const target = path.resolve(dir, decodeURIComponent(link[1].split('#')[0]))
        assert.ok(target.startsWith(dir + path.sep), name + ': offline links must stay within the wiki')
        assert.ok(fs.existsSync(target), name + ' -> ' + link[1])
      }
    }
  }
  const skillDir = path.dirname(bundled)
  const skill = fs.readFileSync(path.join(skillDir, '../SKILL.md'), 'utf8')
  for (const link of skill.matchAll(/\]\((references\/wiki\/[^)]+)\)/g)) assert.ok(fs.existsSync(path.resolve(skillDir, '..', link[1])))
  const llms = fs.readFileSync(path.join(root, 'llms.txt'), 'utf8')
  for (const link of llms.matchAll(/\]\(([^)]+)\)/g)) assert.ok(fs.existsSync(path.resolve(root, link[1])))
})
