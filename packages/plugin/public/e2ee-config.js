/* E2EE transport kill switch. This release disables the encrypted relay path. */
;(function(root) {
  'use strict'
  root.DSH_REMOTE_E2EE_DISABLED = true
})(typeof window === 'undefined' ? globalThis : window)
