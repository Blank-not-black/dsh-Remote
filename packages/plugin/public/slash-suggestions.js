;(function (root) {
  'use strict'

  let closeMenu

  function mount({ input, context, readSkills, t }) {
    const menu = document.createElement('div')
    menu.id = input.id + '-suggestions'
    menu.className = 'slash-suggestions'
    menu.hidden = true
    menu.setAttribute('role', 'listbox')
    input.setAttribute('aria-autocomplete', 'list')
    input.setAttribute('aria-controls', menu.id)
    input.parentElement.prepend(menu)

    let catalog = null, matches = [], selected = null
    const query = () => /^[ \t]*\/([a-z0-9_-]*)$/i.exec(input.value)?.[1]?.toLowerCase()

    function close() {
      const visible = !menu.hidden
      catalog = null
      matches = []
      selected = null
      menu.hidden = true
      menu.replaceChildren()
      input.removeAttribute('aria-activedescendant')
      return visible
    }
    closeMenu = close

    function highlight() {
      const index = matches.findIndex(item => item.name === selected)
      for (const [i, option] of [...menu.children].entries()) {
        option.setAttribute('aria-selected', String(index === i))
      }
      const option = menu.children[index]
      if (option) {
        input.setAttribute('aria-activedescendant', option.id)
        option.scrollIntoView({ block: 'nearest' })
      } else input.removeAttribute('aria-activedescendant')
    }

    function render() {
      const prefix = query()
      if (prefix === undefined || !catalog?.valid() || document.activeElement !== input) {
        close()
        return
      }
      const names = new Map()
      for (const item of [...catalog.commands, ...catalog.skills]) {
        if (typeof item?.name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,199}$/.test(item.name)) continue
        if (!names.has(item.name) && item.name.startsWith(prefix)) names.set(item.name, item)
      }
      matches = [...names.values()]
      menu.setAttribute('aria-label', t('slash.suggestions'))
      menu.replaceChildren(...matches.map((item, index) => {
        const option = document.createElement('button')
        option.type = 'button'
        option.tabIndex = -1
        option.id = menu.id + '-' + index
        option.dataset.index = index
        option.setAttribute('role', 'option')
        const title = document.createElement('span')
        title.className = 'slash-suggestion-title'
        title.textContent = '/' + item.name + (item.hint ? ' ' + item.hint : '')
        const kind = document.createElement('span')
        kind.className = 'slash-suggestion-kind'
        kind.textContent = t(item.kind === 'skill' ? 'slash.skill' : 'slash.command')
        option.append(title, kind)
        if (item.description) {
          const description = document.createElement('span')
          description.className = 'slash-suggestion-description'
          description.textContent = item.description
          option.append(description)
        }
        return option
      }))
      menu.hidden = !matches.length
      highlight()
    }

    function refresh(event) {
      if (event.isComposing) return close()
      if (query() === undefined) return close()
      if (!catalog?.valid()) {
        const scope = context()
        if (!scope) return close()
        const pending = { ...scope, commands: [], skills: [] }
        catalog = pending
        function receive(kind, rows) {
          if (catalog !== pending) return
          pending[kind] = Array.isArray(rows) ? rows.map(item => ({
            ...item, kind: kind === 'skills' ? 'skill' : 'command',
          })) : []
          render()
        }
        const path = '/remote/api/command?sessionId=' + encodeURIComponent(scope.sessionId)
        void fetch(scope.url(path), { headers: scope.headers, signal: AbortSignal.timeout(5000) })
          .then(response => response.ok ? response.json() : null)
          .then(result => receive('commands', result?.commands)).catch(() => {})
        void readSkills(scope.sessionId).then(result => receive('skills', result?.skills)).catch(() => {})
      }
      selected = null
      render()
    }

    function choose(item) {
      if (!item || !catalog?.valid() || query() === undefined) return close()
      close()
      input.value = '/' + item.name + ' '
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }

    input.addEventListener('input', refresh)
    input.addEventListener('compositionend', refresh)
    input.addEventListener('focus', refresh)
    input.addEventListener('blur', close)
    menu.addEventListener('mousedown', event => event.preventDefault())
    menu.addEventListener('click', event => {
      const option = event.target.closest('[data-index]')
      if (option) choose(matches[Number(option.dataset.index)])
    })
    input.addEventListener('keydown', event => {
      if (event.isComposing || event.defaultPrevented || !catalog) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
      if (menu.hidden || !catalog.valid() || query() === undefined || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
      const index = matches.findIndex(item => item.name === selected)
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const next = event.key === 'ArrowDown' ? index + 1 : index < 0 ? matches.length - 1 : index - 1
        selected = matches[(next + matches.length) % matches.length].name
        highlight()
      } else if (event.key === 'Tab' || (event.key === 'Enter' && index >= 0)) {
        event.preventDefault()
        choose(matches[Math.max(0, index)])
      }
    })
  }

  root.DshSlashSuggestions = { mount, close: () => closeMenu?.() }
})(window)
