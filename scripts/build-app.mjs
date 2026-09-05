#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const android = join(root, 'android')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const gradle = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
const run = (file, args, cwd = root) => {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const command = [file, ...args].map(value => /[\s"&|<>^]/.test(String(value)) ? `"${String(value).replace(/"/g, '\\"')}"` : String(value)).join(' ')
    return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { cwd, stdio: 'inherit' })
  }
  return execFileSync(file, args, { cwd, stdio: 'inherit' })
}

run(process.execPath, ['scripts/prepare-version.mjs'])
run(npx, ['cap', 'sync', 'android'])
run(gradle, ['assembleDebug'], android)
