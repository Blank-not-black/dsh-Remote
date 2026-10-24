'use strict'
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { createRequire } = require('node:module')

// A node:test deadline alone cannot interrupt a synchronous parsing loop.
module.exports = function boundedMarkdown({ browser = false, filename = require.resolve('../../public/md.js'), source, timeout = 1000 } = {}) {
  const context = vm.createContext(browser ? { URL } : { module: { exports: {} }, require: createRequire(filename), URL })
  if (browser) {
    for (const name of ['genui.js', 'chat-files.js']) {
      vm.runInContext(fs.readFileSync(path.join(path.dirname(filename), name), 'utf8'), context, { timeout })
    }
  }
  vm.runInContext(source ?? fs.readFileSync(filename, 'utf8'), context, { filename, timeout })
  const call = new vm.Script(browser ? 'mdToHtml(input, options)' : 'module.exports(input, options)')
  return (input, options) => {
    context.input = input
    context.options = options
    return call.runInContext(context, { timeout })
  }
}
