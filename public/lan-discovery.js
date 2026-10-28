/* Android system bridge; browsers keep the existing QR/manual connection paths. */
;(function(root) {
  'use strict'
  root.DshLanDiscovery = { mount(button, paired) {
    const bridge = root.NativeLan
    if (!button || !bridge?.search) return
    button.classList.remove('hidden')
    const en = () => root.I18N?.lang === 'en'
    const text = (zh, english) => en() ? english : zh
    let modal, timer, selected = '', hosts = [], signature = '', busy = false, open = false
    function status(value) { modal.querySelector('[data-lan-status]').textContent = value }
    function close() {
      open = false; clearTimeout(timer); bridge.cancel(); modal?.remove(); modal = null
      button.focus()
    }
    function search() {
      selected = ''; signature = ''; hosts = []; busy = false
      modal.querySelector('[data-lan-pair]').classList.add('hidden')
      modal.querySelector('[data-lan-list]').replaceChildren()
      status(text('正在搜索同一 Wi-Fi 下开放配对的电脑…', 'Searching for computers accepting pairing on this Wi-Fi…'))
      bridge.search()
      clearTimeout(timer); tick()
    }
    function tick() {
      if (!open || !modal) return
      try {
        const state = JSON.parse(bridge.getState() || '{}')
        busy = state.phase === 'pairing'
        modal.querySelector('[data-lan-search]').disabled = busy
        modal.querySelector('[data-lan-connect]').disabled = busy
        modal.querySelector('[data-lan-code]').disabled = busy
        const entries = Array.isArray(state.hosts) ? state.hosts.slice(0, 32) : []
        const next = JSON.stringify(entries)
        if (next !== signature) {
          signature = next; hosts = entries
          const list = modal.querySelector('[data-lan-list]'); list.replaceChildren()
          for (const host of hosts) {
            const entry = document.createElement('button'); entry.type = 'button'; entry.className = 'btn subtle'
            entry.textContent = String(host.name || 'DSH Remote') + ' · ' + String(host.server || '')
            entry.addEventListener('click', () => {
              if (busy) return
              selected = host.id
              modal.querySelector('[data-lan-selected]').textContent = String(host.name || host.server)
              modal.querySelector('[data-lan-pair]').classList.remove('hidden')
              modal.querySelector('[data-lan-code]').focus()
            }); list.append(entry)
          }
        }
        if (state.phase === 'paired') {
          const result = JSON.parse(bridge.takePairResult() || '{}')
          if (!hosts.some(host => host.server === result.server) || typeof result.token !== 'string') throw Error('PAIRING_RESPONSE_INVALID')
          // Close before applying credentials, so no stale poll can apply them a second time.
          close(); paired(result); return
        }
        if (state.phase === 'pairing') status(text('正在验证配对码并连接…', 'Verifying the pairing code…'))
        else if (state.phase === 'done') status(hosts.length ? text('请选择电脑并输入配对码。', 'Select a computer and enter its pairing code.')
          : text('没有找到电脑。请在电脑端开启局域网配对，确认同一 Wi-Fi；也可继续扫码或手动连接。', 'No computers found. Open LAN pairing on the computer and check Wi-Fi, or use QR/manual connection.'))
        else if (state.phase === 'error') {
          const errors = {
            WIFI_REQUIRED: text('请先连接 Wi-Fi。', 'Connect to Wi-Fi first.'),
            NETWORK_PERMISSION_REQUIRED: text('请检查系统网络访问权限。', 'Check system network permissions.'),
            PAIRING_CODE_INVALID: text('配对码不匹配，请核对电脑端显示的配对码。', 'Pairing code does not match the computer.'),
            PAIRING_CLOSED: text('配对已关闭或过期，请在电脑端重新开启。', 'Pairing expired or closed. Reopen it on the computer.'),
          }
          status(errors[state.error] || text('搜索或配对失败，请检查网络后重试；也可扫码连接。', 'Search or pairing failed. Check the network or use QR pairing.'))
        }
      } catch { if (modal) status(text('无法读取搜索状态，请重新搜索。', 'Unable to read discovery status. Search again.')) }
      timer = setTimeout(tick, 300)
    }
    button.addEventListener('click', () => {
      if (open) return
      open = true
      modal = document.createElement('div'); modal.className = 'modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true')
      modal.innerHTML = '<div class="modal-card lan-discovery-card"><div class="modal-title" data-lan-title></div><p data-lan-status role="status" aria-live="polite"></p><div data-lan-list class="lan-host-list"></div><div data-lan-pair class="hidden"><p data-lan-selected></p><label><span data-lan-label></span><input data-lan-code type="password" maxlength="24" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"></label><button data-lan-connect class="btn primary" type="button"></button></div><div class="modal-actions"><button data-lan-search class="btn subtle" type="button"></button><button data-lan-close class="btn subtle" type="button"></button></div></div>'
      modal.querySelector('[data-lan-title]').textContent = text('搜索局域网电脑', 'Find a computer on Wi-Fi')
      modal.querySelector('[data-lan-label]').textContent = text('电脑端显示的限时配对码', 'One-time code shown on the computer')
      modal.querySelector('[data-lan-connect]').textContent = text('配对连接', 'Pair and connect')
      modal.querySelector('[data-lan-search]').textContent = text('重新搜索', 'Search again')
      modal.querySelector('[data-lan-close]').textContent = text('关闭', 'Close')
      modal.querySelector('[data-lan-close]').addEventListener('click', close)
      modal.querySelector('[data-lan-search]').addEventListener('click', search)
      modal.querySelector('[data-lan-connect]').addEventListener('click', () => {
        if (busy) return
        const input = modal.querySelector('[data-lan-code]'), code = input.value
        if (!selected || !/^[a-f0-9]{20}$/i.test(code.replace(/[\s-]/g, ''))) return status(text('请选择电脑，输入完整的 20 位配对码。', 'Select a computer and enter the full 20-character code.'))
        if (!bridge.pair(selected, code)) return status(text('无法开始配对，请重新搜索后重试。', 'Could not start pairing. Search again.'))
        input.value = ''; busy = true; clearTimeout(timer); tick()
      })
      modal.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close() } })
      document.body.append(modal); modal.querySelector('[data-lan-search]').focus(); search()
    })
    document.addEventListener('visibilitychange', () => { if (document.hidden && open) close() })
  } }
})(typeof window === 'object' ? window : globalThis)
