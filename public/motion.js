/* dsh-Remote motion layer: GSAP core + timeline, with reduced-motion and low-cost DOM updates. */
(function () {
  'use strict'

  const gsap = window.gsap
  if (!gsap) return

  const reduceQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  let reduced = !!reduceQuery?.matches
  reduceQuery?.addEventListener?.('change', event => { reduced = !!event.matches })
  const activePulses = new WeakSet()

  function clear(targets) {
    gsap.set(targets, { clearProps: 'opacity,visibility,transform,willChange' })
  }

  function motionKey(node) {
    return node?.dataset?.motionKey || node?.dataset?.id || node?.dataset?.sessionSwipe || node?.dataset?.wbSession || node?.textContent?.slice(0, 80) || ''
  }

  function motionSignature(items) {
    return items.map(motionKey).join('|')
  }

  function view(view) {
    if (!view) return
    const children = [...view.children].filter(child => !child.classList.contains('hidden')).slice(0, 6)
    gsap.killTweensOf([view, ...children])
    if (reduced) {
      clear([view, ...children])
      return
    }
    const tl = gsap.timeline({ defaults: { ease: 'power2.out' } })
    tl.fromTo(view, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.22, clearProps: 'transform' })
      .fromTo(children, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.16, stagger: 0.025, clearProps: 'transform' }, '<0.04')
  }

  function list(container, selector) {
    if (!container) return
    const items = [...container.querySelectorAll(selector)]
    if (!items.length) {
      delete container.dataset.motionListSignature
      return
    }
    const signature = motionSignature(items)
    if (container.dataset.motionListSignature === signature) return
    container.dataset.motionListSignature = signature
    gsap.killTweensOf(items)
    if (reduced) {
      clear(items)
      return
    }
    gsap.fromTo(items, { autoAlpha: 0, y: 8 }, {
      autoAlpha: 1,
      y: 0,
      duration: 0.2,
      ease: 'power2.out',
      stagger: { each: 0.025, from: 'start' },
      clearProps: 'transform'
    })
  }

  // FLIP-style reflow without the optional Flip plugin: read all positions,
  // let the caller render once, then animate only transform/opacity.
  function relayout(container, selector, render) {
    if (!container || typeof render !== 'function') return false
    const existing = [...container.querySelectorAll(selector)]
    const before = new Map(existing.map(node => [motionKey(node), node.getBoundingClientRect()]))
    gsap.killTweensOf(existing)
    render()
    const next = [...container.querySelectorAll(selector)]
    if (reduced) {
      clear(next)
      return true
    }
    const entering = []
    const moving = []
    for (const node of next) {
      const previous = before.get(motionKey(node))
      if (!previous) {
        entering.push(node)
        continue
      }
      const current = node.getBoundingClientRect()
      const x = previous.left - current.left
      const y = previous.top - current.top
      if (Math.abs(x) > 0.5 || Math.abs(y) > 0.5) {
        gsap.set(node, { x, y })
        moving.push(node)
      }
    }
    if (moving.length) {
      gsap.to(moving, {
        x: 0,
        y: 0,
        duration: 0.28,
        ease: 'power2.out',
        stagger: { each: 0.018, from: 'start' },
        clearProps: 'transform'
      })
    }
    if (entering.length) {
      gsap.fromTo(entering, { autoAlpha: 0, y: 8 }, {
        autoAlpha: 1,
        y: 0,
        duration: 0.2,
        ease: 'power2.out',
        stagger: { each: 0.025, from: 'start' },
        clearProps: 'transform'
      })
    }
    return true
  }

  function bindLongPressReorder(container, selector, options = {}) {
    if (!container || !selector) return
    const registry = container.__dshReorderRegistry || (container.__dshReorderRegistry = new Map())
    const existing = registry.get(selector)
    if (existing) {
      existing.options = options
      return
    }
    const LONG_PRESS_MS = 300
    const MOVE_TOLERANCE = 28
    const state = { options, press: null, drag: null, suppressClickUntil: 0 }
    const raf = callback => window.requestAnimationFrame ? window.requestAnimationFrame(callback) : setTimeout(callback, 16)
    const caf = id => window.cancelAnimationFrame ? window.cancelAnimationFrame(id) : clearTimeout(id)
    const itemFrom = target => target?.closest?.(selector)
    const listFrom = item => item?.parentElement || container
    const groupFrom = item => state.options.groupSelector ? (item.closest(state.options.groupSelector) || container) : container
    const keyFrom = item => state.options.key ? state.options.key(item) : motionKey(item)
    const itemsFrom = list => [...list.querySelectorAll(selector)].filter(item => item.parentElement === list)
    const scrollTargetsFrom = item => {
      const targets = []
      let node = item?.parentElement
      while (node && node !== document.body) {
        const style = window.getComputedStyle(node)
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) targets.push(node)
        node = node.parentElement
      }
      if (document.scrollingElement) targets.push(document.scrollingElement)
      return targets
    }
    const reorderDraggedItems = (drag, clientY) => {
      const items = itemsFrom(drag.list).filter(item => item !== drag.item)
      if (!items.length) return
      const firstRects = new Map(items.map(item => [item, item.getBoundingClientRect()]))
      let target = null
      let insertBeforeTarget = false
      for (const item of items) {
        const rect = item.getBoundingClientRect()
        if (clientY < rect.top + rect.height / 2) {
          target = item
          insertBeforeTarget = true
          break
        }
        target = item
      }
      if (!target) return
      const reference = insertBeforeTarget ? target : target.nextElementSibling
      if (reference !== drag.placeholder) drag.list.insertBefore(drag.placeholder, reference || null)
      if (!reduced) {
        for (const item of items) {
          const first = firstRects.get(item)
          const last = item.getBoundingClientRect()
          const x = first.left - last.left
          const y = first.top - last.top
          if (Math.abs(x) > 0.5 || Math.abs(y) > 0.5) {
            gsap.fromTo(item, { x, y }, { x: 0, y: 0, duration: 0.16, ease: 'power2.out', clearProps: 'transform' })
          }
        }
      }
    }
    const autoScroll = drag => {
      if (!drag || state.drag !== drag) return
      const pointerY = drag.pointerY
      const targets = drag.scrollTargets || []
      for (const target of targets) {
        const root = target === document.scrollingElement
          ? { top: 0, bottom: window.innerHeight }
          : target.getBoundingClientRect()
        const threshold = Math.min(78, Math.max(42, (root.bottom - root.top) * 0.14))
        let delta = 0
        if (pointerY < root.top + threshold) {
          const strength = 1 - Math.max(0, pointerY - root.top) / threshold
          if (target.scrollTop > 0) delta = -Math.ceil(4 + strength * 14)
        } else if (pointerY > root.bottom - threshold) {
          const max = target.scrollHeight - target.clientHeight
          const strength = 1 - Math.max(0, root.bottom - pointerY) / threshold
          if (target.scrollTop < max) delta = Math.ceil(4 + strength * 14)
        }
        if (delta) {
          target.scrollTop = Math.max(0, Math.min(target.scrollHeight - target.clientHeight, target.scrollTop + delta))
          reorderDraggedItems(drag, pointerY)
          break
        }
      }
      drag.scrollRaf = raf(() => autoScroll(drag))
    }
    const restoreStyle = (item, style) => {
      if (style == null) item.removeAttribute('style')
      else item.setAttribute('style', style)
    }
    const orderFrom = drag => {
      const order = []
      for (const child of drag.list.children) {
        if (child === drag.placeholder) order.push(keyFrom(drag.item))
        else if (child !== drag.item && child.matches?.(selector)) order.push(keyFrom(child))
      }
      return order
    }
    const animateDrop = (drag, commit) => {
      const floating = drag.item.getBoundingClientRect()
      const order = orderFrom(drag)
      drag.list.insertBefore(drag.item, drag.placeholder)
      drag.placeholder.remove()
      restoreStyle(drag.item, drag.originalStyle)
      const finalRect = drag.item.getBoundingClientRect()
      const dx = floating.left - finalRect.left
      const dy = floating.top - finalRect.top
      if (!reduced && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)) {
        gsap.fromTo(drag.item, { x: dx, y: dy, scale: 1.02 }, {
          x: 0,
          y: 0,
          scale: 1,
          duration: 0.24,
          ease: 'power2.out',
          clearProps: 'transform'
        })
      } else if (reduced) clear(drag.item)
      if (commit) {
        const callback = drag.options.onCommit
        const payload = { item: drag.item, list: drag.list, group: drag.group, order }
        if (callback) setTimeout(() => callback(payload), reduced ? 0 : 240)
      }
    }
    const restoreDrag = (drag, commit) => {
      if (!commit) {
        const originalNext = drag.originalNextSibling?.parentElement === drag.list ? drag.originalNextSibling : null
        drag.list.insertBefore(drag.placeholder, originalNext)
      }
      animateDrop(drag, commit)
    }
    const setPageScrollLock = locked => {
      document.documentElement.classList.toggle('reorder-scroll-lock', locked)
    }

    const cancelPress = () => {
      if (!state.press) return
      clearTimeout(state.press.timer)
      state.press.item.classList.remove('reorder-pressing')
      state.press = null
    }
    const finishDrag = (commit) => {
      const drag = state.drag
      if (!drag) return
      state.drag = null
      drag.item.classList.remove('reorder-dragging')
      drag.item.removeAttribute('aria-grabbed')
      drag.item.releasePointerCapture?.(drag.pointerId)
      if (drag.scrollRaf != null) caf(drag.scrollRaf)
      container.classList.remove('reorder-active')
      setPageScrollLock(false)
      if (commit) state.suppressClickUntil = Date.now() + 680
      restoreDrag(drag, commit)
    }
    const activate = () => {
      const press = state.press
      if (!press) return
      state.press = null
      const rect = press.item.getBoundingClientRect()
      const originalNextSibling = press.item.nextElementSibling
      const placeholder = document.createElement('div')
      placeholder.className = 'reorder-placeholder'
      placeholder.setAttribute('aria-hidden', 'true')
      placeholder.style.height = `${rect.height}px`
      placeholder.style.width = `${rect.width}px`
      press.item.before(placeholder)
      state.drag = {
        ...press,
        options: state.options,
        placeholder,
        originalStyle: press.item.getAttribute('style'),
        originalNextSibling,
        startY: press.y,
        pointerY: press.y,
        scrollTargets: scrollTargetsFrom(press.item)
      }
      press.item.setPointerCapture?.(press.pointerId)
      press.item.classList.remove('reorder-pressing')
      press.item.classList.add('reorder-dragging')
      press.item.setAttribute('aria-grabbed', 'true')
      press.item.style.position = 'fixed'
      press.item.style.left = `${rect.left}px`
      press.item.style.top = `${rect.top}px`
      press.item.style.width = `${rect.width}px`
      press.item.style.zIndex = '20'
      press.item.style.pointerEvents = 'none'
      if (!reduced) {
        gsap.set(press.item, { scale: 1.02 })
        state.drag.yTo = gsap.quickTo(press.item, 'y', { duration: 0.12, ease: 'power2.out' })
      }
      container.classList.add('reorder-active')
      setPageScrollLock(true)
      const drag = state.drag
      drag.scrollRaf = raf(() => autoScroll(drag))
    }
    const onPointerDown = event => {
      if (state.press || state.drag) return
      if (event.button != null && event.button !== 0) return
      const item = itemFrom(event.target)
      if (!item || !container.contains(item)) return
      const currentOptions = state.options || {}
      if (currentOptions.handleSelector && !event.target.closest(currentOptions.handleSelector)) return
      if (currentOptions.excludeSelector && event.target.closest(currentOptions.excludeSelector)) return
      const list = listFrom(item)
      const group = groupFrom(item)
      if (!itemsFrom(list).includes(item)) return
      const press = { item, list, group, pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer: 0 }
      press.timer = setTimeout(activate, LONG_PRESS_MS)
      state.press = press
      item.classList.add('reorder-pressing')
    }
    const onPointerMove = event => {
      const press = state.press
      if (press && !state.drag) {
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_TOLERANCE) cancelPress()
        return
      }
      const drag = state.drag
      if (!drag || drag.pointerId !== event.pointerId) return
      event.preventDefault()
      drag.pointerY = event.clientY
      if (!reduced) drag.yTo?.(event.clientY - drag.startY)
      reorderDraggedItems(drag, event.clientY)
    }
    const onPointerUp = event => {
      if (state.press?.pointerId === event.pointerId) cancelPress()
      if (state.drag?.pointerId === event.pointerId) finishDrag(true)
    }
    const onPointerCancel = event => {
      if (state.press?.pointerId === event.pointerId) cancelPress()
      if (state.drag?.pointerId === event.pointerId) finishDrag(false)
    }
    const touchPoint = event => event.changedTouches?.[0] || event.touches?.[0]
    const touchPointerEvent = event => {
      const point = touchPoint(event)
      if (!point) return null
      return {
        target: event.target,
        button: 0,
        pointerId: 10000 + point.identifier,
        clientX: point.clientX,
        clientY: point.clientY,
        preventDefault: () => event.preventDefault()
      }
    }
    const onTouchStart = event => {
      const normalized = touchPointerEvent(event)
      if (normalized) onPointerDown(normalized)
    }
    const onTouchMove = event => {
      const normalized = touchPointerEvent(event)
      if (normalized) onPointerMove(normalized)
    }
    const onTouchEnd = event => {
      const normalized = touchPointerEvent(event)
      if (normalized) onPointerUp(normalized)
    }
    const onTouchCancel = event => {
      const normalized = touchPointerEvent(event)
      if (normalized) onPointerCancel(normalized)
    }
    const onDocumentMove = event => {
      if (state.drag) event.preventDefault()
    }
    const pointerIdFromEvent = event => {
      if (event.pointerId != null) return event.pointerId
      const point = touchPoint(event)
      return point ? 10000 + point.identifier : null
    }
    const onDocumentEnd = (event, commit) => {
      const pointerId = pointerIdFromEvent(event)
      if (state.press && (pointerId == null || state.press.pointerId === pointerId)) cancelPress()
      if (state.drag && (pointerId == null || state.drag.pointerId === pointerId)) finishDrag(commit)
    }
    const onWindowBlur = () => onDocumentEnd({}, false)
    const onVisibilityChange = () => {
      if (document.hidden) onDocumentEnd({}, false)
    }
    const onContextMenu = event => {
      if (state.press || state.drag) event.preventDefault()
    }
    const onClick = event => {
      if (Date.now() >= state.suppressClickUntil) return
      if (itemFrom(event.target)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    container.addEventListener('pointerdown', onPointerDown)
    container.addEventListener('pointermove', onPointerMove)
    container.addEventListener('pointerup', onPointerUp)
    container.addEventListener('pointercancel', onPointerCancel)
    container.addEventListener('lostpointercapture', onPointerCancel)
    container.addEventListener('touchstart', onTouchStart, { passive: false })
    container.addEventListener('touchmove', onTouchMove, { passive: false })
    container.addEventListener('touchend', onTouchEnd, { passive: false })
    container.addEventListener('touchcancel', onTouchCancel, { passive: false })
    container.addEventListener('contextmenu', onContextMenu)
    container.addEventListener('click', onClick, true)
    document.addEventListener('touchmove', onDocumentMove, { passive: false, capture: true })
    document.addEventListener('pointermove', onDocumentMove, { passive: false, capture: true })
    document.addEventListener('pointerup', event => onDocumentEnd(event, true), { passive: false, capture: true })
    document.addEventListener('pointercancel', event => onDocumentEnd(event, false), { passive: false, capture: true })
    document.addEventListener('touchend', event => onDocumentEnd(event, true), { passive: false, capture: true })
    document.addEventListener('touchcancel', event => onDocumentEnd(event, false), { passive: false, capture: true })
    window.addEventListener('blur', onWindowBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    registry.set(selector, state)
  }

  function overlay(node) {
    if (!node) return
    const card = node.querySelector('.modal-card, .ds-modal-card, .sheet, .ds-drawer') || node
    gsap.killTweensOf([node, card])
    if (reduced) {
      clear([node, card])
      return
    }
    const isSideDrawer = card.classList.contains('ds-drawer')
    const isSheet = card.classList.contains('sheet')
    const tl = gsap.timeline({ defaults: { ease: 'power3.out' } })
    tl.fromTo(node, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.16 })
      .fromTo(card,
        { autoAlpha: 0, x: isSideDrawer ? 28 : 0, y: isSheet ? 24 : 8, scale: isSideDrawer || isSheet ? 1 : 0.985 },
        { autoAlpha: 1, x: 0, y: 0, scale: 1, duration: isSheet ? 0.24 : 0.2, clearProps: 'transform' },
        '<'
      )
  }

  function pulse(targets) {
    if (reduced) return clear(targets)
    const nodes = typeof targets === 'string' ? document.querySelectorAll(targets) : targets
    for (const node of nodes || []) {
      if (activePulses.has(node)) continue
      activePulses.add(node)
      gsap.to(node, { scale: 1.12, autoAlpha: 0.62, duration: 0.85, ease: 'sine.inOut', repeat: -1, yoyo: true, transformOrigin: '50% 50%' })
    }
  }

  window.DshMotion = { gsap, reduced: () => reduced, view, list, relayout, bindLongPressReorder, overlay, pulse }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.view:not(.hidden), .ds-view:not(.hidden)').forEach(node => view(node))
  }, { once: true })

  const observer = new MutationObserver(records => {
    for (const record of records) {
      const node = record.target
      if (!(node instanceof HTMLElement)) continue
      const becameVisible = record.oldValue?.split(/\s+/).includes('hidden') && !node.classList.contains('hidden')
      if (!becameVisible) continue
      if (node.matches('.view, .ds-view')) view(node)
      else if (node.matches('.modal, .ds-modal, .sheet, .ds-drawer')) overlay(node)
    }
  })
  observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true })
})()
