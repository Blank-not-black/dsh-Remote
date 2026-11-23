import { readFileSync } from 'node:fs'

export function readEmbeddedSource(file) {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
}
