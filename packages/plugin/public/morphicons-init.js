/*
 * Local morphicons bridge for the zero-build WebUI.
 *
 * The vendored element keeps a static SVG child as its first-paint fallback.
 * UI code only changes data-morph-state; this bridge turns that state change
 * into a morph without coupling the application code to the vendor API.
 */
import { defineMorphIcon } from './vendor/morphicons/element.js'

defineMorphIcon()

function syncMorphIcon(element) {
  if (!element || !('icon' in element)) return
  const state = element.dataset.morphState === 'open' ? 'open' : 'closed'
  const next = state === 'open' ? element.dataset.morphOpen : element.dataset.morphClosed
  if (!next || element.icon === next) return
  element.icon = next
}

function syncMorphIcons(root = document) {
  if (root.matches?.('morph-icon[data-morph-closed][data-morph-open]')) syncMorphIcon(root)
  root.querySelectorAll?.('morph-icon[data-morph-closed][data-morph-open]').forEach(syncMorphIcon)
}

function bootMorphIcons() {
  syncMorphIcons()
  const observer = new MutationObserver(records => {
    for (const record of records) syncMorphIcon(record.target)
  })
  observer.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-morph-state']
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootMorphIcons, { once: true })
} else {
  bootMorphIcons()
}
