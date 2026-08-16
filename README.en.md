# 📱 DSH Remote

> **The DSH console in your pocket** — remote sessions · approvals · questions · file transfer, over LAN / Tailscale

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![npm](https://img.shields.io/npm/v/dsh-remote-plugin)](https://www.npmjs.com/package/dsh-remote-plugin)
[![Release](https://img.shields.io/github/v/release/Blank-not-black/dsh-Remote?label=release)](https://github.com/Blank-not-black/dsh-Remote/releases/latest)
[![Stars](https://img.shields.io/github/stars/Blank-not-black/dsh-Remote)](https://github.com/Blank-not-black/dsh-Remote)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Android%20%7C%20Linux%20%7C%20Windows-blue)](#)

**English** · [中文](README.md)

Approve DSH tool calls from bed. Check sessions from the couch. Push photos from your phone straight into the server — **a native Android app, not a PWA wrapper**.

**Plugin + built-in gateway + Android app are one unit**: installing the plugin ships the gateway with it and keeps it running alongside DSH; the drawer hands you the token and host IP directly, and the app is ready to control DSH from anywhere.

## ✨ Highlights

| | |
| --- | --- |
| 📱 **Native Android app** | Not a PWA wrapper: sessions / approvals / questions / goals / file transfer, all in one app |
| 🔐 **Self-healing gateway** | Auto-starts and restarts with DSH; Bearer-token auth — whoever has the token controls DSH |
| 📦 **2 GB file transfer** | Direct `/fs/*` transfer with **resumable uploads** + pause/resume/cancel + **SHA-256 integrity check** |
| ⚡ **Auto server switching** | Add LAN / Tailscale addresses; latency test picks the fastest one automatically |
| 🛡️ **Path security** | Path traversal and symlink escapes rejected; upload roots configurable via whitelist |
| 📴 **Offline cache** | Session list and viewed history stay browsable when the gateway is unreachable |
| 🔄 **QR pairing** | Scan a QR in the drawer — server address + token configured in one step |
| 🪟 **Single-file gateway** | Node-free standalone binaries for Windows / Linux |
| 🎨 **Four themes** | Default Deep Space / Sunset / Elbphilharmonie / Prairie Tower, switchable from a panel; follows system light/dark by default |

## 📸 Screenshots

| Android app | Android app |
| --- | --- |
| ![Sessions](docs/screenshots/mobile-sessions.png) | ![Approvals](docs/screenshots/mobile-approvals.png) |
| ![Files](docs/screenshots/mobile-files.png) | ![Settings](docs/screenshots/mobile-settings.png) |

| Gateway admin panel | |
| --- | --- |
| ![Gateway admin panel](docs/screenshots/gateway.png) | |

## 🚀 Quick start

```sh
# One command installs the plugin (gateway ships inside; auto-starts with DSH)
dsh plugin --profile web add dsh-remote-plugin
```

1. Restart DSH Web, hard-refresh the browser (**Ctrl+F5**)
2. Find the **DSH Remote** entry at the bottom of the left sidebar — the drawer shows **token, host IP, device monitor**; nothing to download or configure manually
3. Install `dsh-remote.apk` from [Releases](https://github.com/Blank-not-black/dsh-Remote/releases/latest), open App **Settings → Scan to connect**, scan the QR from the drawer — pairing done

> The plugin is also installable from git sources:
> ```sh
> # 2) monorepo git source
> dsh plugin --profile web add "github:Blank-not-black/dsh-Remote#main&path:/packages/plugin"
> # 3) standalone plugin repo (Oh-My-DSH catalog entry)
> dsh plugin --profile web add "github:Blank-not-black/dsh-remote-plugin#main"
> ```

## 🧩 Components

| Component | Role | Install |
| --- | --- | --- |
| DSH plugin (`packages/plugin`) | Native sidebar entry + drawer admin panel; **bundles the gateway and manages its lifecycle** | one `dsh plugin` command |
| Gateway (`gateway.js` / single-file binary) | Token-authenticated proxy on port 8787 + device monitor + update check + **`/fs/*` file transfer**; auto-started by the plugin | bundled with plugin; also standalone |
| Android app (`dsh-remote.apk`) | Remote sessions/approvals/questions/goals/file transfer; in-app update check | GitHub Releases |

## ⚙️ Gateway lifecycle & self-healing

- The drawer's **Stop gateway / Start gateway** buttons control it; intent persists in `~/.dsh-remote/gateway.enabled`
- **Default `on`**: after a DSH restart or an unexpected gateway exit, the plugin relaunches it within seconds
- Clicking **Stop gateway** writes `off` — no auto-restart until you click Start; disable management entirely with `DSH_REMOTE_AUTOSTART=0`
- Token lives in `~/.dsh-remote/token` (auto-generated on first run, reused afterwards)

## 📲 Android app

1. Install `dsh-remote.apk` from [Releases](https://github.com/Blank-not-black/dsh-Remote/releases/latest)
2. **Recommended: QR pairing** — open the plugin drawer (or the standalone gateway's `/admin` page), click **QR code**, scan it in App **Settings → Scan to connect**; address + token configured in one go
3. Manual setup: copy the drawer's **token** and **host IP**; add server addresses in App Settings (multiple allowed, e.g. LAN `http://192.168.x.x:8787` + Tailscale `http://100.x.x.x:8787`), tap **Test latency** to auto-select the fastest; then paste the token
4. The mobile browser can also open `http://<PC-IP>:8787/?token=xxx` directly

- **Firewall**: when the phone can't reach the gateway, open port 8787 — Linux: `sudo firewall-cmd --permanent --add-port=8787/tcp && sudo firewall-cmd --reload`; Windows: allow on first-run prompt
- **In-app updates**: Settings → Check for updates, one-tap download & install

### What you can do on the phone

| Tab | Features |
| --- | --- |
| Sessions | Session list, run-state/goal badges, stats, new session |
| Detail | Live conversation, scroll-up history, goal control (pause/resume/complete/edit/clear), subagent interrupt, send message, stop task |
| Files | Browse/enter/back, pull-to-refresh, download to system `Download/dsh-remote` folder (DownloadManager), upload with progress, **pause/resume/cancel + SHA-256 check** |
| Approvals | Tool-call approvals (allow/deny), user questions (choose/custom answer), background tasks |
| Settings | Multiple server addresses (latency-test auto-switch), token, **scan to connect**, notifications toggle, tool-call display, DSH status probe, update check |

> 💾 Chat history is cached locally per session: sessions and viewed history stay browsable offline when the gateway is unreachable.

## 📁 File transfer (LAN / Tailscale direct)

`/fs/*` endpoints power the Files tab in both the app and the browser console. Everything is direct-connection: uploads default to **2 GB** max (configurable), both directions support **resumable transfer**; app uploads support **pause/resume/cancel** with a **SHA-256 integrity check** before final write (mismatched chunks are kept, never written into the target directory).

| Endpoint | Method | Description |
| --- | --- | --- |
| `/fs/list?path=xxx` | GET | List directory; `path` defaults to `~`; returns `{path, entries:[{name,type,size,mtimeMs}]}` |
| `/fs/file?path=xxx` | GET | Streaming download; supports `Range: bytes=a-b`; UTF-8 filename in `Content-Disposition` |
| `/fs/upload?path=dir&name=file` | POST | Raw body or `multipart/form-data`; 409 on name collision, add `overwrite=1` |
| `/fs/upload?…&session=uuid&offset=N[&finish=1][&sha256=hex]` | POST | **Chunked resume**: each chunk written at offset of `.name.dsh-remote-part-<session>`; on `finish=1` verifies `sha256` then atomically renames, 422 on mismatch |
| `/fs/upload-probe?path=..&name=..&session=..` | GET | Query uploaded chunk size (probe before resuming after disconnect) |
| `/fs/upload-control?path=..&name=..&session=..&action=cancel` | POST | Cancel upload: stop in-flight write stream and delete chunks (pause = client disconnects, chunks kept) |

- **Auth**: every `/fs/*` request requires the token — `Authorization: Bearer <token>` or `?token=<token>`; missing token → 401
- **Security**: all paths are resolved and must stay inside the allowed roots (default `~`); `../` traversal and symlinks pointing outside are rejected; `DSH_REMOTE_FS_ROOT=/home/you:/mnt/data` enables multiple roots (`:`-separated)
- **Limits**: `DSH_REMOTE_FS_MAX_UPLOAD` (bytes, default `2147483648` = 2 GB)

```bash
TOKEN=$(cat ~/.dsh-remote/token); HOST=http://127.0.0.1:8787
curl -H "Authorization: Bearer $TOKEN" "$HOST/fs/list"                            # list ~
curl -H "Authorization: Bearer $TOKEN" "$HOST/fs/list?path=~/Downloads"           # list downloads
curl -OJ -H "Authorization: Bearer $TOKEN" "$HOST/fs/file?path=~/Downloads/big.iso" # download (resume: add -r 0-1048575)
curl -H "Authorization: Bearer $TOKEN" --data-binary @./photo.jpg \
     "$HOST/fs/upload?path=~/Downloads&name=photo.jpg"                             # upload; append &overwrite=1 on 409
```

## 🖥️ Drawer / admin panel

- Gateway version / uptime / host IPs / DSH upstream status / request stats
- **Connected devices**: type (app / browser / admin), IP, online state, request count, channel, last active — annotate and disconnect
- Token display + one-click copy; **token QR** (app pairing) and **one-click rotation** (old token invalidated instantly, devices must re-pair); GitHub update check (every 6 h)

## 🚪 Standalone gateway (no plugin / Windows hosts)

Run the gateway on its own when you don't want the plugin or the host has no systemd:

| Platform | File |
| --- | --- |
| Windows x64 | `dsh-remote-win-x64.exe` (double-click, no Node needed) |
| Linux x64 | `dsh-remote-linux-x64` (`chmod +x` and run) |

```bash
./dsh-remote-linux-x64            # default 0.0.0.0:8787
PORT=9000 ./dsh-remote-linux-x64  # custom port
TOKEN=xxx ./dsh-remote-linux-x64  # fixed token (otherwise generated to ~/.dsh-remote/token)
```

Admin page at `http://127.0.0.1:8787/admin` (token required in standalone mode): host IPs, upstream reachability, device monitor, annotate/disconnect devices, GitHub update check, **token QR & one-click rotation**.

## 🌐 Remote access (cross-network)

Outside LAN, use **Tailscale**: sign both machines into the same account, enter `http://<PC's Tailscale IP>:8787` in App Settings — encrypted link.

## 🏗️ Architecture

**Integrated mode (recommended)**

```
DSH web (3080)
   ├─ dsh-remote plugin /remote ──► host browser: sidebar entry + drawer admin
   └─ auto lifecycle ──► dsh-remote-gateway.service (0.0.0.0:8787, Bearer token)
                              ▲
       Android app / mobile browser (LAN or Tailscale)
       static assets + auth + /api/* proxy + device monitor
                              │
                              ▼
                         DSH web (127.0.0.1:3080)
```

**Standalone gateway mode** (same `gateway.js` single file, no plugin)

```
Mobile browser / Android app ── http://PC-IP:8787 + token ──► gateway.js ──► DSH web (127.0.0.1:3080)
```

- Everything goes through DSH's official `/api` RPC (`session.*` / `subagent.*` / `goal.*`), event streams over WebSocket with auto-reconnect
- The gateway stores no business data; tokens live only on the host and your phone. **⚠️ Whoever holds the token controls DSH — keep it safe.**

## 🔧 Run from source

Requires Node.js ≥ 18:

```bash
git clone https://github.com/Blank-not-black/dsh-Remote.git
cd dsh-Remote
npm install
npm start        # gateway, default 0.0.0.0:8787
```

## 🛠️ Development & release

```bash
npm run sync-plugin       # sync public/ into plugin package + copy gateway.cjs + plugin update.json
npm run sync-standalone   # generate/push dsh-remote-plugin standalone repo (Oh-My-DSH entry)
npm run build-app         # build Android APK (needs Android SDK; fixed signing in android/app/build.gradle)
npm run build-bin         # package Windows/Linux single-file binaries
npm run publish           # copy APK + update.json + sync plugin package
```

**Fully automated release**: edit `updateNotes` in `package.json`, then one command:

```bash
npm run release 0.5.0    # bump version → build APK+plugin locally → commit → push main → tag & push
```

After the tag is pushed, CI (`.github/workflows/release-build.yml`) takes over: builds APK + Linux/Win binaries → generates `SHA256SUMS.txt` and changelog → uploads GitHub Release → publishes npm → syncs the standalone repo. Repository secrets needed once: `NPM_TOKEN`, `DSH_RELEASE_DEPLOY_KEY`.

## 📄 License

MIT
