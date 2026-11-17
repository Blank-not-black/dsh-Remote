'use strict'

const WINDOW_MS = 60_000
const COOLDOWN_MS = 15 * WINDOW_MS
const HIGH_BYTES = 16 * 1024 * 1024

// Keep one observation per authorization, shared across its connections.
// A warning is operational evidence of sustained traffic, not a policy decision.
function observeTraffic(runtime, bytes, { report, now = () => performance.now(), highBytes = HIGH_BYTES }) {
  const time = now()
  const window = Math.floor(time / WINDOW_MS)
  const sample = runtime.trafficObservation ||= { window, bytes: 0, consecutive: 0, nextAlertAt: 0 }
  if (sample.window !== window) {
    sample.consecutive = sample.window === window - 1 && sample.bytes >= highBytes ? sample.consecutive + 1 : 0
    sample.window = window
    sample.bytes = 0
  }
  sample.bytes += bytes
  if (sample.consecutive < 2 || sample.bytes < highBytes || sample.nextAlertAt > time) return
  sample.nextAlertAt = time + COOLDOWN_MS
  report({ event: 'SPONSOR_RELAY_SUSTAINED_TRAFFIC', grantId: runtime.id,
    consecutiveWindows: sample.consecutive + 1, windowSeconds: WINDOW_MS / 1000,
    thresholdBytes: highBytes, currentWindowBytes: sample.bytes })
}

module.exports = { observeTraffic }
