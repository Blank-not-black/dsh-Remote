# DSH Remote

> A mobile remote console for DSH: inspect sessions, handle approvals, and monitor the host from a phone or another computer.

[English](README.en.md) · [中文](README.md)

[![npm](https://img.shields.io/npm/v/dsh-remote-plugin)](https://www.npmjs.com/package/dsh-remote-plugin)
[![Release](https://img.shields.io/github/v/release/Blank-not-black/dsh-Remote?label=release)](https://github.com/Blank-not-black/dsh-Remote/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/Blank-not-black/dsh-Remote/release-build.yml?branch=main&label=CI)](https://github.com/Blank-not-black/dsh-Remote/actions/workflows/release-build.yml)
[![Compat](https://img.shields.io/github/actions/workflow/status/Blank-not-black/dsh-Remote/compat.yml?branch=main&label=compat)](https://github.com/Blank-not-black/dsh-Remote/actions/workflows/compat.yml)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

DSH Remote is made of three cooperating parts: a DSH plugin, a standalone gateway, and an Android app / WebUI. The plugin adds the DSH-side entry point and manages the gateway; the gateway handles authentication and proxying; the mobile and desktop surfaces are optimized for their respective layouts.

### Connect in about three minutes

```sh
dsh plugin --profile web add dsh-remote-plugin
```

Fully restart DSH Web, then open DSH Remote from the sidebar. The management console checks DSH, the gateway, LAN addressing, the host firewall, client pairing, and realtime channels in order. Start the gateway, scan the QR code, and continue the session from your phone. See [Quick start](#quick-start-plugin-mode-recommended) for the complete guide.

> Keep the phone and host on the same trusted LAN or connect them through Tailscale. Do not expose the gateway port directly to the public Internet or publish a pairing token.

## What it is for

- Check DSH sessions, answer questions, or handle tool approvals from your phone.
- Send an image into the current session, or sync files between your phone and computer with the open-source [Syncthing](https://github.com/syncthing/syncthing).
- Monitor sessions, device connections, and token usage from another computer.
- Connect over a LAN or Tailscale without adding a separate account system to DSH.

## Current surfaces

### Mobile / Android app

The mobile surface opens on the home dashboard. Its four destinations are:

| Tab | Main content |
| --- | --- |
| Sessions | Session list, workbench projects, state, archive, and new sessions |
| Home | DSH version, gateway state, link health, pending work, and recent activity |
| Stats | Four token buckets, cost, peak share, and seven-day usage |
| Settings | Servers, token, notifications, background polling, themes, updates, and feedback |

Session detail supports live messages, history loading, goals, subagent interruption, slash commands, model selection, and fullscreen input. Fullscreen input keeps the session header visible and moves the send action into the header. It can be closed with the collapse button, a downward swipe on the top handle, or the system back action.

The image attachment action supports the camera and gallery. Images are sent as image content in `session.prompt`; actual image support still depends on the composed DSH services and selected model route.

### Desktop WebUI

Opening the gateway URL in a desktop browser automatically uses the desktop layout: session and workbench sidebar, home dashboard, statistics drawer, settings, server groups, theme switching, and approval / question notification cards.

### Plugin panel and admin console

The DSH plugin opens a compact status panel with gateway state, device count, token usage, and quick actions. The full admin console provides gateway version, uptime, port, DSH upstream status, host IPs, connected devices, request counts, token statistics, QR pairing, token rotation, a first-connection Doctor checklist, gateway controls, self-healing settings, and update checks.

## Downloads

Stable release assets are published on [GitHub Releases](https://github.com/Blank-not-black/dsh-Remote/releases/latest):

| Platform | Asset | Notes |
| --- | --- | --- |
| Android | `dsh-remote.apk` | Mobile console with camera, notifications, and in-app updates |
| Windows x64 | `dsh-remote-win-x64.exe` | Single-file gateway; no extra Node.js installation |
| Linux x64 | `dsh-remote-linux-x64` | Single-file gateway; make it executable before running |
| macOS Apple Silicon | `dsh-remote-macos-arm64` | Separate preview artifact; not promised to follow the stable cadence |

## Quick start: plugin mode (recommended)

First confirm that DSH Web itself opens on the host. Then install the plugin as the same OS user that runs the `web` profile:

```sh
dsh plugin --profile web add dsh-remote-plugin
dsh plugin --profile web list --depth 0
```

The second command verifies that the package is installed in the `web` profile. Completely restart the DSH Web process, hard-refresh the browser with Ctrl+F5, and open DSH Remote from the sidebar. If DSH Web is a user service, a typical restart is `systemctl --user restart dsh-web`; if it is run manually, stop the old `dsh web` process and launch it again.

Before pairing a phone, open `http://127.0.0.1:8787/health` on the DSH host. A JSON response confirms that the gateway port is available. Copy the token or use the QR code from the plugin panel. On a phone, enter `http://PC-LAN-IP:8787` or the host's Tailscale address—never `127.0.0.1` or `localhost`, because those point to the phone itself.

Pinned and source installs are also supported:

```sh
dsh plugin --profile web add dsh-remote-plugin@0.6.8
dsh plugin --profile web add "github:Blank-not-black/dsh-Remote#main&path:/packages/plugin"
```

The plugin bundles the gateway, which listens on `0.0.0.0:8787` by default and self-heals with DSH. The lifecycle intent is stored at `~/.dsh-remote/gateway.enabled`; the token is stored at `~/.dsh-remote/token`.

## Gateway cannot be opened

Test from the DSH host first, then from the phone:

```bash
curl -i http://127.0.0.1:8787/health
ss -ltnp | grep ':8787'
curl -i http://127.0.0.1:3080/
```

On Windows, use `netstat -ano | findstr :8787` or `Invoke-RestMethod http://127.0.0.1:8787/health` in PowerShell.

| Symptom | What to check |
| --- | --- |
| Local port 8787 refuses the connection | The plugin may be in the wrong profile, autostart may be disabled, DSH Web may not have been restarted, or another process may own the port. Check the plugin panel and restart DSH Web. |
| `/health` says `ok: true` but `upstreamOk: false` | The gateway is running; DSH Web on port 3080 is unavailable. Treat this as a degraded upstream, not a missing gateway. |
| Local access works but the phone cannot connect | Use the host LAN/Tailscale IP, ensure both devices can reach each other, disable Wi-Fi client isolation if applicable, and allow inbound **TCP 8787** in the host firewall. Do not expose DSH port 3080 publicly. |
| The UI returns 401 | The network path works, but the token is wrong. Pair again or copy the current `~/.dsh-remote/token`. |
| The UI is blank or unchanged after an upgrade | Hard-refresh with Ctrl+F5 or fully close and reopen the app to clear stale static assets. |
| A custom port does not work | Effective priority is `DSH_REMOTE_GATEWAY_PORT`, then `~/.dsh-remote/gateway-port`, then 8787. Update the URL and firewall rule together. |

For a systemd-managed DSH Web installation, inspect `systemctl --user status dsh-web --no-pager` and `journalctl --user -u dsh-web -n 100 --no-pager`. The plugin gateway may be a transient process, so `systemctl --user restart dsh-remote-gateway.service` is not a portable restart command; use the plugin's Start Gateway action or restart DSH Web. Remove tokens before sharing logs or screenshots.

## Standalone gateway

When you do not want the DSH plugin, download the single-file gateway for your platform:

```sh
./dsh-remote-linux-x64

# Custom port or fixed token
PORT=9000 TOKEN=your-token ./dsh-remote-linux-x64
```

The default upstream is `http://127.0.0.1:3080`, the default listen address is `0.0.0.0:8787`, and the admin page is `http://127.0.0.1:8787/admin`.

## File sync

DSH Remote no longer includes arbitrary file transfer: the Files tab and the `/fs` endpoints have been removed. Sending photos or gallery images as session attachments is still supported.

To sync files between your phone and computer, use the open-source [Syncthing](https://github.com/syncthing/syncthing): it is peer-to-peer, cross-platform, and does not depend on third-party cloud services.

## Remote access and security

- LAN: put the phone and computer on the same network and use the computer's LAN IP.
- Tailscale: join both devices to the same tailnet and use the computer's `100.x.x.x` address.
- Public tunnels: use an authenticated tunnel with reliable WebSocket support and restrict its exposure.

The gateway listens on all interfaces by default. The token is a remote-control credential for DSH: do not commit it, publish it in screenshots, or share it inside a URL. Realtime communication uses WebSocket and automatically falls back to polling after repeated failures, returning to WebSocket when possible.

## Notifications, announcements, and background polling

- Notification settings cover approvals / questions, peak reminders, background polling, and task completion.
- Settings → Notifications → Announcement history stores fetched announcements for later review.
- Place `announcements.json` beside `update.json` to publish version- and date-filtered plain-text announcements. Set `"force": true` when the user must acknowledge one before closing it.
- An announcement may include a single-choice `poll` with an `id`, `question`, and 2–8 `{id, label, description}` options. The gateway validates the announcement, poll, and option IDs against its local announcement file before forwarding structured vote fields to the existing feedback collector. It also emits a stable `POLL {...}` message for compatibility with older collectors that retain only common fields. A vote is marked locally only after the collector confirms success, and an unvoted poll can be reopened from Announcement history.
- Run `node scripts/summarize-polls.mjs /path/to/feedback.jsonl` (or add `--json`) for privacy-minimized counts and percentages. The summary does not print contact details or IP addresses.
- Announcement checks currently run once after the app/page starts; they are not realtime. Refresh or reopen an already-running client after publishing a new poll.

Android background polling runs through a foreground service at 30 seconds, 1 minute, 5 minutes, or 15 minutes. Doze may stretch the actual interval when the screen is off; some Android vendors also require allowing auto-start, background running, and unrestricted battery use.

## Themes and feedback

Four themes are retained: Default Deep Space, Sunset, Elbphilharmonie, and Prairie Tower. Theme variables apply to surfaces, icons, and status colors so icons remain readable after switching themes.

The app, desktop UI, and admin console all expose feedback entry points. “Write feedback” in the app / desktop UI is forwarded by the gateway to the feedback collector; you can also use [GitHub Issues](https://github.com/Blank-not-black/dsh-Remote/issues).

## Development and release

The project keeps the gateway dependency-free at runtime, ships a single-file gateway, and uses a zero-build plain JavaScript WebUI. Edit the root `public/` directory and then synchronize the plugin copy.

```bash
npm install
npm run check          # syntax checks + Node tests
npm run sync-plugin    # sync public/, gateway.cjs, and plugin assets
npm run build-app      # build the Android APK
npm run publish        # copy the APK, write update.json, and sync the plugin
npm run build-bin      # build Windows/Linux single-file gateways
```

For a stable release:

```bash
npm run release 0.6.8
```

The release script updates the stable version, builds the APK, synchronizes the plugin, commits and pushes `main`, and pushes the `v0.6.8` tag. GitHub Actions then builds the Windows/Linux gateways and APK, generates `SHA256SUMS.txt`, uploads the GitHub Release, publishes npm, and synchronizes the standalone plugin repository.

## Repository layout

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
