'use strict'
/** update.json 的 history 数组生成 —— release / prepare-version / publish 共享。
 * 规则: 只收 {version,notes} 合法项; rc 版本不进 history; 正式版去重后压栈并截断到 10 条。 */
function mergeHistory(oldHistory, version, notes) {
  let history = Array.isArray(oldHistory)
    ? oldHistory.filter(h => h && typeof h.version === 'string' && typeof h.notes === 'string')
    : []
  if (!String(version).includes('-rc')) {
    history = history.filter(h => h.version !== version)
    history.unshift({ version, notes })
    history = history.filter(h => !String(h.version).includes('-rc')).slice(0, 10)
  }
  return history
}

module.exports = { mergeHistory }