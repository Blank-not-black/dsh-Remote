/* Preserve the standalone gateway: embed the tested LAN factory at sync time. */
import { readFileSync, writeFileSync } from 'node:fs'
const source = readFileSync(new URL('../lib/lan-pairing.cjs', import.meta.url), 'utf8')
const factory = source.slice(source.indexOf('function createLanPairing('), source.indexOf('\nmodule.exports'))
const url = new URL('../gateway.js', import.meta.url), current = readFileSync(url, 'utf8')
const begin = '// BEGIN EMBEDDED LAN PAIRING', end = '// END EMBEDDED LAN PAIRING'
const block = `${begin}\n${factory}\n${end}`
const next = current.includes(begin) ? current.slice(0, current.indexOf(begin)) + block + current.slice(current.indexOf(end) + end.length)
  : current.replace('function newAccessToken()', () => block + '\n\nfunction newAccessToken()')
if (process.argv.includes('--check')) {
  if (next !== current) { console.error('LAN pairing factory is not synchronized'); process.exitCode = 1 }
} else if (next !== current) writeFileSync(url, next)
