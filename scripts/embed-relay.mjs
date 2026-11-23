// Keep the distributed gateway self-contained. Edit relay/*.cjs, not the generated region.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readEmbeddedSource } from './read-embedded-source.mjs'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const names = ['registry.cjs', 'wire.cjs', 'options.cjs', 'client.cjs', 'e2ee-channel.cjs', 'e2ee-identity.cjs', 'e2ee-devices.cjs', 'gateway-sockets.cjs', 'e2ee-endpoint.cjs', 'http-headers.cjs', 'file-rate.cjs', 'basic-policy.cjs', 'host.cjs']
const modules = names.map(name => `${JSON.stringify('./' + name)}: function(require, module, exports) {\n${readEmbeddedSource(join(root, 'relay', name)).trim()}\n}`).join(',\n')
const region = `// BEGIN GENERATED RELAY HOST\nconst embeddedRelayHost = (() => {\nconst factories = {\n${modules}\n}\nconst cache = Object.create(null)\nfunction load(name) {\n  if (!factories[name]) return require(name)\n  if (cache[name]) return cache[name].exports\n  const entry = cache[name] = { exports: {} }\n  factories[name](load, entry, entry.exports)\n  return entry.exports\n}\nreturn load('./host.cjs')\n})()\n// END GENERATED RELAY HOST`
const file = join(root, 'gateway.js')
const source = readEmbeddedSource(file)
const marker = /\/\/ BEGIN GENERATED RELAY HOST[\s\S]*?\/\/ END GENERATED RELAY HOST/
if (!marker.test(source)) throw new Error('Missing embedded relay region')
const updated = source.replace(marker, () => region)
if (updated !== source) {
  if (process.argv.includes('--check')) throw new Error('Embedded relay is stale; run npm run sync-plugin')
  writeFileSync(file, updated)
}
