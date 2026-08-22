# DSH Remote (0.7.0-mod)

> A remote console for DSH: inspect sessions, handle approvals, transfer files, and monitor the host from a phone or another computer.

[English](README.en.md) · [中文](README.md)

- **Upstream project**: [Blank-not-black/dsh-Remote](https://github.com/Blank-not-black/dsh-Remote)
- **This repository (mod branch)**: [produce123/dsh-Remote-mod](https://github.com/produce123/dsh-Remote-mod)

The `mod` branch of this repository continues development on top of upstream v0.6.9 (the major refactor release). v0.6.9-mod brought changes 1–7 below; v0.7.0-mod fixes the mobile voice input and the offline voice-pack 404 and slims the repo (changes 8–10). Apart from these, everything else matches upstream; see the original project's README for full documentation.

DSH Remote is made of three cooperating parts: a DSH plugin, a standalone gateway, and an Android app / WebUI. The plugin adds the DSH-side entry point and manages the gateway; the gateway handles authentication, realtime connections, and file transfer; the mobile and desktop surfaces are each optimized for their scenarios.

## ✨ Changes on top of v0.6.9

| # | Change | Description |
| --- | --- | --- |
| 1 | **Unified admin entry** | The plugin no longer renders its own admin page. `/remote/admin`, `/remote/admin/`, `/remote/admin.html`, and `/remote/admin/index.html` all redirect to the standalone gateway's admin page (carrying the token automatically); on the gateway side, `/admin`, `/admin/`, and `/admin/index.html` also resolve to the same single admin UI. |
| 2 | **Desktop archive collapse fix** | The session-list "archive collapse" toggle and session open actions are now bound once via event delegation instead of being re-bound on every render, fixing the archive expand / collapse behavior. |
| 3 | **Device list fix** | The gateway device list is aggregated by real device (IP): WebSocket channel records and polling / file-request records of the same device merge into one row, and multiple channels (mux/host) are counted together; admin-page visits no longer count as "connected devices"; the device / online counts come from the same aggregated list, removing phantom entries such as "6 rows for 2 devices". |
| 4 | **Mobile voice input (with long-press selection fix)** | New voice input: Android system SpeechRecognizer bridged via SpeechBridge, with a browser webkit recognition fallback. Two entries — a "hold to talk" button in the composer and a keyboard voice key; slide up to cancel, with a live waveform overlay. While holding to talk, text selection and the long-press context menu are globally disabled, fixing the conflict where the system long-press text selection interrupted the voice gesture. Fullscreen input supports voice too. |
| 5 | **Bottom-pinned composer (Doubao-style)** | With the bottom navigation hidden in a session, the composer is pinned flush to the bottom of the screen (safe-area handled by the composer padding), in the Doubao-style bottom layout. |
| 6 | **Settings → General → Voice input extension** | A new "Voice input" settings page: transcription mode (raw text / polished prompt), OpenAI-compatible API (Base / Model / Key) configuration, connection test, a function-test page (try hold-to-talk), and offline recognition pack (SenseVoice-Small) download and management. |
| 7 | **Desktop link detection fix** | Desktop link status is now measured against the gateway's `/health` (gateway online + DSH upstream reachable) instead of indirect "server / token configured" checks. When the gateway is online but the upstream probe fails, a `host.describe` recheck avoids false alarms from a misconfigured health-probe path. Opening `:8787` directly (no server configured) no longer falsely reports "gateway offline". Results expire after 20 s and re-probe automatically; a "checking" state is shown while probing. |
| 8 | **Mobile voice input fix** | Voice recognition now uses the system speech service by default (widest compatibility) instead of blindly preferring on-device recognition; devices without an installed on-device language pack no longer fail instantly. When the system network recognizer is unavailable, it automatically retries once with the on-device engine. |
| 9 | **Offline voice-pack download fix** | Removed the example.com placeholder default URL that always returned 404; the offline pack download now requires a real, downloadable direct zip link (empty input prompts the user) — no more "download failed HTTP 404". |
| 10 | **Repository-wide slimming** | Removed dead code and duplicated implementations across the gateway, frontend, and scripts (~660 lines); dropped the unused @capacitor/camera dependency. Zero new dependencies; release shape unchanged. |

## 🚀 Quick start

### Standalone gateway (no plugin)

```sh
node gateway.js                            # default listen 0.0.0.0:8787, upstream 127.0.0.1:3080
PORT=9000 TOKEN=your-token node gateway.js # custom port or fixed token
```

After startup:

- Open `http://PC-IP:8787` in a phone / desktop browser → mobile / desktop WebUI;
- Admin page: `http://PC-IP:8787/admin`;
- File endpoints require a Bearer token and reject path traversal; uploads support chunking, resume, and SHA-256 verification.

Platform single-file gateways (Windows / Linux binaries, no Node.js installation required) are also available for download.

### Plugin mode (DSH-embedded entry)

```sh
dsh plugin --profile web add dsh-remote-plugin   # or install packages/plugin from this repo
```

The plugin adds the DSH-side entry and manages the gateway automatically (start / stop / self-healing); the gateway port and token can be adjusted from the admin page.

> 🔐 The token is your remote-control credential. There is no extra account system by default, which keeps deployment simple — but protect it like an SSH key.

## 🧪 Build and test

```bash
npm install
npm run check          # syntax checks + Node tests (node --check + node --test)
npm run build-app      # build the Android APK
npm run sync-plugin    # sync public/ and gateway.cjs into the plugin package
```

Project constraints: zero new runtime dependencies, a single-file gateway (gateway.js / gateway.cjs), and a zero-build plain JavaScript WebUI. Edit the root `public/` directory for WebUI changes, then synchronize the plugin copy.

## 🗂️ Repository layout

```text
gateway.js                 # single-file gateway source
public/                    # mobile, desktop, admin, and shared assets
packages/plugin/           # DSH plugin and synchronized plugin assets
android/                   # Capacitor Android project
tests/                     # gateway, Markdown, and statistics tests
scripts/                   # sync, build, and release scripts
```

## License

MIT
