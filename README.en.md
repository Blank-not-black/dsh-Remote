# DSH Remote

> A mobile remote console for DSH: inspect sessions, handle approvals, transfer files, and monitor the host from a phone or another computer.

[English](README.en.md) · [中文](README.md)

[![npm](https://img.shields.io/npm/v/dsh-remote-plugin)](https://www.npmjs.com/package/dsh-remote-plugin)
[![Release](https://img.shields.io/github/v/release/Blank-not-black/dsh-Remote?label=release)](https://github.com/Blank-not-black/dsh-Remote/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/Blank-not-black/dsh-Remote/release-build.yml?branch=main&label=CI)](https://github.com/Blank-not-black/dsh-Remote/actions/workflows/release-build.yml)
[![Compat](https://img.shields.io/github/actions/workflow/status/Blank-not-black/dsh-Remote/compat.yml?branch=main&label=compat)](https://github.com/Blank-not-black/dsh-Remote/actions/workflows/compat.yml)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dshbase listed](https://dshbase.com/badges/dsh-Remote.svg)](https://dshbase.com/plugins/dsh-Remote/)
[![dsh.so risk](https://www.dsh.so/badge/dsh-remote-2.svg)](https://www.dsh.so/artifact/dsh-remote-2/)
[![dsh.so install](https://www.dsh.so/badge/install/dsh-remote-2.svg)](https://www.dsh.so/artifact/dsh-remote-2/)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![dsh-remote-plugin on dsh.fish](https://dsh.fish/a/dsh-remote-plugin/badge.svg)](https://dsh.fish/a/dsh-remote-plugin)
[![dshplugin.dev listed](https://dshplugin.dev/badges/blank-not-black-dsh-remote-plugin.svg)](https://dshplugin.dev/plugins/blank-not-black-dsh-remote-plugin)
[![dshfind](https://dshfind.com/api/badge/Blank-not-black/dsh-Remote)](https://dshfind.com/en/plugins/Blank-not-black/dsh-Remote?ref=badge)

DSH Remote has three parts: a DSH plugin, a standalone gateway, and clients for Android, HarmonyOS, and the WebUI. The plugin adds the DSH-side entry point and manages the gateway; the gateway handles authentication, realtime connections, and file transfer; clients provide layouts for phones, tablets, and desktop browsers.

### Connect in about three minutes

```sh
dsh plugin --profile web add dsh-remote-plugin
```

Fully restart DSH Web, then open DSH Remote from the sidebar. The management console checks DSH, the gateway, LAN addressing, the host firewall, client pairing, and realtime channels in order. Start the gateway, scan the QR code, and continue the session from your phone. See [Quick start](#quick-start-plugin-mode-recommended) for the complete guide.

> Keep the phone and host on the same trusted LAN or connect them through Tailscale. Do not expose the gateway port directly to the public Internet or publish a pairing token.

## What it is for

- Check DSH sessions, answer questions, or handle tool approvals from your phone.
- Transfer files between your phone and the DSH workspace, or send an image into the current session.
- Monitor sessions, files, device connections, and token usage from another computer.
- Connect over a LAN or Tailscale without adding a separate account system to DSH.

## Current surfaces

### Mobile / Android app

The mobile surface opens on the home dashboard. Its five destinations are:

| Tab | Main content |
| --- | --- |
| Sessions | Session list, workbench projects, state, archive, and new sessions |
| Files | Browse, download, upload, resume, pause, continue, and cancel |
| Home | DSH version, gateway state, link health, pending work, and recent activity |
| Plugins | Installed plugins, discovery, configuration toggles, and operation history |
| Settings | Servers, token, model providers, feature tests, notifications, background polling, themes, updates, feedback, and About |

The Plugins tab has its own management surface. Home retains a usage summary, and the statistics button in the session header opens token, cost, and trend details.

Session detail supports live messages, history loading, goals, subagent interruption, slash commands, model selection, and fullscreen input. Messages can be queued while DSH is busy. Long-press steer sending is optional and off by default; DSH accepting a steer request does not mean the current tool has stopped. Fullscreen input keeps the session header visible and moves the send action into the header. It can be closed with the collapse button, a downward swipe on the top handle, or the system back action.

The image attachment action supports the camera and gallery. Images are sent as image content in `session.prompt`; actual image support still depends on the composed DSH services and selected model route.

### HarmonyOS app

The repository includes the HarmonyOS client source in ArkTS / ArkUI, with phone and tablet layouts that connect to the same gateway. Version 0.7.3 does not include a HarmonyOS HAP. See the [HarmonyOS project guide](harmonyos/README.md) and [client module notes](docs/modules/11-harmonyos-app.md) for build and signing instructions; an unsigned HAP requires your own DevEco signing configuration before installation. The current contributor-credits change has not been built or verified on a HarmonyOS device.

### Desktop WebUI

Opening the gateway URL in a desktop browser automatically uses the desktop layout: session and workbench sidebar, file transfer, home dashboard, statistics drawer, settings, server groups, theme switching, and approval / question notification cards.

### Plugin panel and admin console

The DSH plugin opens a compact status panel with gateway state, device count, token usage, and quick actions. The full admin console provides gateway version, uptime, port, DSH upstream status, host IPs, connected devices, request counts, token statistics, QR pairing, token rotation, a first-connection Doctor checklist, gateway controls, self-healing settings, and update checks.

### Plugin management and session insights

The mobile and desktop Plugins pages provide installed plugins, discovery, installation, updates, removal, configuration toggles, and operation history. Available actions depend on the host's management capabilities; the UI stays read-only when it cannot verify a management entry point. DSH Desktop uses its built-in plugin management. See the [plugin center notes](docs/plugin-center.md).

In a session, open the header’s More actions menu and select “Context & costs” to open two read-only panels. Context composition and occupancy require `dsh-context` installed and enabled on the host. Session costs, balances, and plan usage require `dsh-cost-meter` and host-side Remote plugin support. Missing data is shown as unavailable; cost estimates defer to the provider's bill and are kept separate from Remote's own statistics. These panels have not been ported to HarmonyOS. See the [session insights notes](docs/plugin-insights.md).

### UI updates in 0.7.3

Version 0.7.3 includes the following UI changes; HarmonyOS changes are source-only:

- Mobile and desktop hide sessions marked `blank` by DSH from the main list, workspace tree, and home statistics. Sessions become visible after their first turn starts; raw session and subagent data are retained.
- Settings → About adds offline contributor credits and a link to the full contribution history, ordered by GitHub contribution commit counts. HarmonyOS lists contributors in its About DSH Remote dialog; its build and device validation are still pending.

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

Before pairing a phone, open `http://127.0.0.1:8787/health` on the DSH host. A JSON response confirms that the gateway port is available. Copy the token or use the QR code from the plugin panel. On Android or an installed HarmonyOS client, scan the QR code or enter `http://PC-LAN-IP:8787` and the token—never `127.0.0.1` or `localhost`, because those point to the phone itself.

The npm `latest` tag tracks stable releases and `next` tracks release candidates. Replace either tag with an exact version when pinning; source installs are also supported:

```sh
dsh plugin --profile web add dsh-remote-plugin@latest
dsh plugin --profile web add dsh-remote-plugin@next
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

In Docker or panel-managed deployments, the container may only see its own interfaces. Set `DSH_REMOTE_ADVERTISE_HOSTS=192.168.1.20,100.64.0.2`, or add a reachable host IP/hostname from the admin console; these addresses are included in pairing QR codes. Set `DSH_REMOTE_DSH_CONTROL_MODE=disabled` when Docker Compose, a panel, or another platform owns the DSH lifecycle. The UI then hides invalid start/restart actions and explains that lifecycle management is external.

## File transfer

The Files tab is available on mobile and desktop. Gateway file endpoints require a Bearer token. Linux and macOS default to the current user's home directory plus workspaces confirmed by DSH. Windows defaults to the current user's directory and other available drive letters; access remains limited by the account running the gateway.

- Default single-file upload limit: 2 GB, configurable with `DSH_REMOTE_FS_MAX_UPLOAD`.
- Uploads support chunks, resume, pause, continue, and cancel.
- SHA-256 is checked before an upload is atomically placed at its final path.
- Path traversal, absolute escapes, and symlinks outside allowed roots are rejected.
- `DSH_REMOTE_FS_ROOT` configures multiple allowed roots (`:` on Linux/macOS, `;` on Windows).

The Windows file tree supports drive-letter paths, mixed slash input, and explicitly authorized UNC shares. System directories and other users' C: paths remain closed by default, including junctions that point into them. Newly mounted drives are detected after restarting the gateway. Use `DSH_REMOTE_FS_ROOT` to configure allowed roots; access remains subject to Windows account permissions.

```bash
TOKEN=$(cat ~/.dsh-remote/token)
HOST=http://127.0.0.1:8787
curl -H "Authorization: Bearer $TOKEN" "$HOST/fs/list"
curl -OJ -H "Authorization: Bearer $TOKEN" "$HOST/fs/file?path=~/Downloads/example.zip"
curl -H "Authorization: Bearer $TOKEN" --data-binary @./photo.jpg \
  "$HOST/fs/upload?path=~/Downloads&name=photo.jpg"
```

## Remote access and security

- LAN: put the phone and computer on the same network and use the computer's LAN IP.
- Tailscale: join both devices to the same tailnet and use the computer's `100.x.x.x` address.
- Public tunnels: use an authenticated tunnel with reliable WebSocket support and restrict its exposure.

The gateway listens on all interfaces by default. The token is a remote-control credential for DSH: do not commit it, publish it in screenshots, or share it inside a URL. Realtime communication uses WebSocket and automatically falls back to polling after repeated failures, returning to WebSocket when possible.

The admin console can enable independent device keys. The shared token then grants access to the admin console, while each phone or browser gets its own key that can be paired, rotated, or revoked. Changing the mode or a key disconnects affected realtime sessions. Keys are stored in `~/.dsh-remote/device-keys.json` by default; set `DSH_REMOTE_DEVICE_KEYS` to change the path.

When Caddy Basic Auth protects the plugin UI, apply the same login policy to `/remote/` and `/remote/admin/api/*`. The embedded admin page does not overwrite the browser's Basic `Authorization` header with a Bearer token. If the proxy rewrites an API request to a login page, the UI reports an authentication-layer error instead of clearing the Remote token in a login loop.

## Notifications, announcements, and background polling

- Notification settings cover approvals / questions, peak reminders, background polling, and task completion.
- Settings → Notifications → Announcement history stores fetched announcements for later review.
- The gateway reads the central HTTPS announcement feed, caches it briefly, and falls back to the bundled `announcements.json` when the feed cannot be reached. Announcements are filtered by version and dates and rendered as plain text; set `"force": true` when the user must acknowledge one before closing it. `DSH_REMOTE_ANNOUNCEMENTS_URL` overrides the feed URL; an empty value disables it.
- An announcement may include a single-choice `poll` with an `id`, `question`, and 2–8 `{id, label, description}` options. The gateway validates the announcement, poll, and option IDs against its cached feed (or the bundled fallback) before forwarding structured vote fields to the existing feedback collector. It also emits a stable `POLL {...}` message for compatibility with older collectors that retain only common fields. A vote is marked locally only after the collector confirms success, and an unvoted poll can be reopened from Announcement history.
- Run `node scripts/summarize-polls.mjs /path/to/feedback.jsonl` (or add `--json`) for privacy-minimized counts and percentages. The summary does not print contact details or IP addresses.
- Clients check shortly after launch, periodically while in the foreground, and again after returning to the foreground or network recovery. The gateway retains the last successful feed during temporary source outages.

Android background polling runs through a foreground service at 30 seconds, 1 minute, 5 minutes, or 15 minutes. Doze may stretch the actual interval when the screen is off; some Android vendors also require allowing auto-start, background running, and unrestricted battery use.

## Themes and feedback

Five themes are available: Default Deep Space, Sunset, Elbphilharmonie, Prairie Tower, and Monochrome. Theme variables apply to surfaces, icons, and status colors so icons remain readable after switching themes.

The app, desktop UI, and admin console all expose feedback entry points. “Write feedback” in the app / desktop UI is forwarded by the gateway to the feedback collector; you can also use [GitHub Issues](https://github.com/Blank-not-black/dsh-Remote/issues).

## Development and release

The project adds no runtime dependencies, ships a single-file gateway, and uses a zero-build plain JavaScript WebUI. Edit the root `public/` directory and then synchronize the plugin copy. The native HarmonyOS app uses system ArkUI components and SDK APIs.

```bash
npm install
npm run check          # syntax checks + Node tests
npm run sync-plugin    # sync public/, gateway.cjs, and plugin assets
npm run build-app      # build the Android APK
npm run publish        # copy the APK, write update.json, and sync the plugin
npm run build-bin      # build Windows/Linux single-file gateways
```

RC and stable versions use this command. Replace `<version>` with the target version in `x.y.z` or `x.y.z-rc.N` format:

```bash
npm run release <version>
```

The release script updates version metadata, builds the Android APK locally, synchronizes the plugin, and commits and pushes `main` plus the version tag. GitHub Actions builds the APK and Windows/Linux single-file gateways, then generates `SHA256SUMS.txt`, uploads a GitHub Release, publishes npm, and synchronizes the standalone plugin repository. RC packages use the npm `next` tag; stable packages use `latest`. Add `--no-build` to skip the local APK build and let CI build the release assets.

## Repository layout

```text
gateway.js                 # single-file gateway source
public/                    # mobile, desktop, admin, and shared assets
packages/plugin/           # DSH plugin and synchronized plugin assets
android/                   # Capacitor Android project
harmonyos/                 # native ArkTS / ArkUI app
tests/                     # gateway, Markdown, and statistics tests
scripts/                   # sync, build, and release scripts
```

## Contributors and thanks

Thank you to everyone who contributes code, fixes, documentation, and feedback to DSH Remote.

The list follows GitHub's contribution commit counts in descending order, with usernames breaking ties, matching the client credits:

1. [Blank-not-black](https://github.com/Blank-not-black)
2. [wikkd](https://github.com/wikkd)
3. [anupamme](https://github.com/anupamme)
4. [liuchang-t](https://github.com/liuchang-t)

See [GitHub Contributors](https://github.com/Blank-not-black/dsh-Remote/graphs/contributors) for the full history. The current development version also provides offline credits and profile links under **Settings → About** on mobile and desktop. HarmonyOS lists the same contributors under **Settings → About DSH Remote**, with a link to the full contribution history.

## License

MIT

### Windows Desktop control (experimental)

When Desktop loads Remote, the plugin records the verified executable, shell and Host identities, profile directory, and upstream address. With the gateway online, mobile DSH controls can start or restart Desktop. Restart closes and reopens the desktop application and interrupts active tasks. The gateway requires matching process birth times, executable paths, Host ancestry, and listener ownership; it refuses ambiguous instances and waits for the Host to exit before launching another instance. This does not configure Windows login startup. Remote startup requires the computer and gateway to remain online.

### Conversation cache and crash recovery (0.7.3)

Both WebUI clients display the current connection identity’s local history first, then reconcile DSH history in the background. Identical records reuse DOM nodes and preserve the reading position. Cache, sync and offline status are visible. Rendering is limited to 180 records and memory to 5,000; older records are loaded in pages and returning to latest can reload the tail. IndexedDB retains up to 10 sessions per identity, each with up to 250 records and approximately 750,000 characters of event data, with a bounded local-storage fallback. Mobile reset also clears the conversation cache.

Plugin-started gateways and `npm start` use supervision in the same gateway file; direct invocations can use `node gateway.js --supervise` or add `--supervise` to the standalone executable. Abnormal exits retry after 1, 2, 4, 8 and 16 seconds, at most 5 times per 5 minutes. Intentional shutdown and listener conflicts do not restart. Gateway-owned DSH children can recover from abnormal exits; adopted Windows Desktop instances require a matching Application Error event 1000, executable, PID and process birth time. Normal closure and network failure do not trigger recovery. External services, containers and launchers retain their own lifecycle management.

Set `DSH_REMOTE_AUTO_RESTART=0` to disable recovery. Local structured records go to `~/.dsh-remote/crashes.jsonl` (override with `DSH_REMOTE_CRASH_LOG_FILE`), rotate at approximately 128 KiB and retain one backup. They contain timestamps, components, exit codes, retry counts and source positions, without arbitrary error text, conversations or credentials. Feedback log consent is off by default and offers a preview of up to 3 recent records. Explicit submission uses the existing `/feedback` → cloud `/submit` route and its deployed `serverInfo` field (500 characters maximum); complete local logs are never automatically uploaded. Recovery cannot be guaranteed after the computer or supervisor itself stops, and Desktop recovery requires a matching Windows crash event.
