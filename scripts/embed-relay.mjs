// Keep the distributed gateway self-contained. Edit relay/*.cjs, not the generated region.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const names = ['registry.cjs', 'wire.cjs', 'options.cjs', 'client.cjs', 'host.cjs']
const modules = names.map(name => `${JSON.stringify('./' + name)}: function(require, module, exports) {\n${readFileSync(join(root, 'relay', name), 'utf8').trim()}\n}`).join(',\n')
const region = `// BEGIN GENERATED RELAY HOST\nconst embeddedRelayHost = (() => {\nconst factories = {\n${modules}\n}\nconst cache = Object.create(null)\nfunction load(name) {\n  if (!factories[name]) return require(name)\n  if (cache[name]) return cache[name].exports\n  const entry = cache[name] = { exports: {} }\n  factories[name](load, entry, entry.exports)\n  return entry.exports\n}\nreturn load('./host.cjs')\n})()\n// END GENERATED RELAY HOST`
const file = join(root, 'gateway.js')
const source = readFileSync(file, 'utf8')
const marker = /\/\/ BEGIN GENERATED RELAY HOST[\s\S]*?\/\/ END GENERATED RELAY HOST/
if (!marker.test(source)) throw new Error('Missing embedded relay region')
const updated = source.replace(marker, () => region)
if (updated !== source) {
  if (process.argv.includes('--check')) throw new Error('Embedded relay is stale; run npm run sync-plugin')
  writeFileSync(file, updated)
}
