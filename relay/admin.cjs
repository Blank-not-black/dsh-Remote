'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { Registry } = require('./registry.cjs')
function main() {
  const args = require('./options.cjs')(process.argv.slice(2))
  if (!args.state) throw new Error('STATE_FILE_REQUIRED')
  const command = args._[0]
  let registry = new Registry(args.state)
  if (command === 'init') {
    Registry.init(args.state, { origin: args.origin, baseDomain: args['base-domain'], tunnelHost: args['tunnel-host'], tunnelPort: args['tunnel-port'] || 443 })
    console.log('Relay registry initialized.')
  } else if (command === 'issue') {
    if (!args.out) throw new Error('INVITE_OUTPUT_FILE_REQUIRED')
    const output = path.resolve(args.out)
    if (fs.existsSync(output)) throw new Error('OUTPUT_ALREADY_EXISTS')
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 })
    const issued = registry.issue({ label: args.label, domain: args.domain, expiresAt: Date.now() + Number(args.days || 7) * 86400000 })
    try {
      fs.writeFileSync(output, JSON.stringify({ server: registry.read().origin, code: issued.code }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    } catch (error) { registry.revoke(issued.grant.id); throw error }
    console.log(JSON.stringify({ ...issued.grant, inviteFile: output }))
  } else if (command === 'list') console.log(JSON.stringify(registry.list(), null, 2))
  else if (command === 'usage') {
    const file = path.join(path.dirname(path.resolve(args.state)), 'usage.json')
    console.log(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{"tenants":[]}')
  }
  else if (command === 'revoke') console.log(JSON.stringify(registry.revoke(args.id)))
  else throw new Error('USE_INIT_ISSUE_LIST_USAGE_OR_REVOKE')
}
if (require.main === module) {
  try { main() } catch (error) { console.error(error.code || error.message); process.exitCode = 1 }
}
module.exports = { main }
