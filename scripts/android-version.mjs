import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Android's upgrade counter is independent of the user-facing semantic version.
export function androidVersion(version, versionCode) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.[1-9]\d*)?$(?![\s\S])/.test(version)) throw new Error('Invalid Android release version: ' + version)
  if (!Number.isInteger(versionCode) || versionCode <= 0 || versionCode > 2100000000) throw new Error('androidVersionCode must be an integer in 1..2100000000')
  return { versionName: version.replace('-', '.'), versionCode }
}

export function releaseAndroidVersion(pkg, targetVersion) {
  androidVersion(pkg.version, pkg.androidVersionCode)
  return androidVersion(targetVersion, pkg.androidVersionCode + (targetVersion === pkg.version ? 0 : 1))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(androidVersion(process.argv[2], /^\d+$/.test(process.argv[3] || '') ? Number(process.argv[3]) : NaN))) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
