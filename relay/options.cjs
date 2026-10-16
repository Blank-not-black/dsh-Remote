'use strict'
module.exports = function options(args) {
  const result = { _: [] }
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) result._.push(args[i])
    else {
      const key = args[i].slice(2)
      if (!key || i + 1 >= args.length || args[i + 1].startsWith('--') || Object.hasOwn(result, key)) throw new Error('Invalid CLI option')
      result[key] = args[++i]
    }
  }
  return result
}
