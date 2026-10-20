/* Shared presentation model. Missing evidence is unknown, never healthy or zero. */
'use strict'
;(function (root) {
  function derive(state) {
    const st = state || {}
    const gateway = st.mode === 'gateway'
    const processRunning = gateway || st.gatewayRunning === true
    const authenticated = gateway && !st.gatewayAuthError
    const upstream = st.upstream?.reachable === true ? 'ok' : st.upstream?.reachable === false ? 'error' : 'unknown'
    const events = st.events || {}
    const realtime = events.mux?.connected === true && events.host?.connected === true ? 'ok'
      : events.mux?.connected === false || events.host?.connected === false ? 'warning' : 'unknown'
    const connections = Array.isArray(st.devices) ? st.devices.filter(d => d && (d.kind === 'app' || d.kind === 'web')) : null
    const online = connections ? connections.filter(d => d.online === true) : null
    const phase = !state ? 'unknown' : st.gatewayAuthError ? 'auth' : !processRunning ? 'stopped'
      : !authenticated ? 'attention' : upstream === 'error' ? 'upstream' : upstream === 'unknown' ? 'unknown'
        : realtime === 'warning' ? 'partial' : realtime === 'unknown' ? 'unknown' : 'ready'
    return {
      phase, upstream, realtime, processRunning, authenticated,
      gateway: authenticated ? 'ok' : processRunning ? 'warning' : state ? 'error' : 'unknown',
      connections, online, onlineCount: online ? online.length : null,
      history: !!(connections?.length || st.deviceKeys?.entries?.length),
      canStart: !!state && !processRunning && st.gatewayInstalled !== false,
    }
  }
  root.DshRemoteState = { derive }
})(globalThis)
