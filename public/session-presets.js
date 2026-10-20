/* Host-provided Agent conversation types. No guessed presets or saved defaults. */
'use strict'
;(function(root) {
  const records = new WeakMap()
  const en = () => root.I18N?.lang === 'en'
  const label = (zh, english) => en() ? english : zh
  function option(select, value, name, disabled = false) {
    const el = document.createElement('option')
    el.value = value; el.textContent = name; el.disabled = disabled; select.append(el)
  }
  async function open({select, hint, rpc, connection, rendered = () => {}}) {
    if (select.labels?.[0]) select.labels[0].textContent = label('对话类型', 'Conversation type')
    const record = {connection, rows:[], ready:false}
    records.set(select, record)
    select.replaceChildren(); option(select, '', label('跟随主机默认', 'Use host default'))
    select.value = ''; select.disabled = true
    hint.textContent = label('正在读取主机的对话类型…', 'Reading conversation types from the host…')
    rendered()
    try {
      const result = await rpc('agentPresets.list', {}, 10000)
      if (records.get(select) !== record || !connection.valid()) return
      if (!Array.isArray(result?.presets)) throw new Error('unsupported')
      const seen = new Set()
      record.rows = result.presets.slice(0,100).filter(row => typeof row?.id === 'string' && row.id.length > 0 && row.id.length <= 200 && !seen.has(row.id) && seen.add(row.id))
      for (const row of record.rows) option(select, row.id, (row.name || row.id) + (row.isDefault ? label('（主机默认）',' (host default)') : '') + (row.broken ? label(' · 暂不可用', ' · unavailable') : ''), !!row.broken)
      record.ready = true
      select.disabled = !record.rows.some(row=>!row.broken)
      const describe = () => {
        const row = record.rows.find(row=>row.id === select.value) || record.rows.find(row=>row.isDefault)
        hint.textContent = select.value ? String(row?.description || label('仅用于这次新对话。','Applies to this new conversation only.')).slice(0,600) : label('创建时使用主机当前默认类型；不会修改主机默认设置。', 'Use the host default at creation time. This does not change the host default.')
      }
      select.onchange = describe; describe()
    } catch {
      if (records.get(select) !== record || !connection.valid()) return
      hint.textContent = label('主机暂未提供可选类型，将使用主机默认。', 'Conversation types are unavailable; the host default will be used.')
    }
    if (records.get(select) === record && connection.valid()) rendered()
  }
  function selection(select) {
    const record = records.get(select)
    if (!record?.connection.valid()) return {valid:false, payload:{}}
    if (!select.value) return {valid:true, payload:{}}
    const row = record.rows.find(row=>row.id === select.value && !row.broken)
    return row && record.ready ? {valid:true, payload:{agentPreset:row.id}} : {valid:false, payload:{}}
  }
  root.DshSessionPresets = {open, selection, staleMessage:()=>label('连接或类型已变化，请重新打开新建对话。','The connection or type has changed. Reopen the new conversation form.')}
})(window)
