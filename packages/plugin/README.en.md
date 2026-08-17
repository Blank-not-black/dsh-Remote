# dsh-remote-plugin

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

**English** · [中文](README.md)

The DSH bundle plugin for DSH Remote: registers a native entry in DSH's left sidebar and opens an admin drawer from the right. The plugin **bundles the gateway and auto-starts/stops it with DSH** (standalone systemd unit); the drawer shows the token, host IP and device monitor. Works with the [dsh-Remote](https://github.com/Blank-not-black/dsh-Remote) Android app for remote control and file transfer (`/fs/list`, `/fs/file`, `/fs/upload`). The panel ships four themes (Deep Space / Sunset / Elbphilharmonie / Prairie Tower) — light / dark / neutral, following the system preference automatically.

## Install

```sh
dsh plugin --profile web add dsh-remote-plugin
# or pin a version
dsh plugin --profile web add dsh-remote-plugin@0.5.0
```

Restart DSH Web and hard-refresh (Ctrl+F5); the app icon entry appears at the bottom of the left sidebar.

git source install (equivalent):

```sh
dsh plugin --profile web add "github:Blank-not-black/dsh-Remote#main&path:/packages/plugin"
```

## Gateway

- Auto-start by default: on DSH startup or drawer refresh, the plugin launches the built-in `gateway.cjs` (`0.0.0.0:8787`), independent of the DSH process; Linux uses a standalone systemd unit, and environments without systemd (e.g. macOS) automatically fall back to a resident child process.
- On/off intent persists in `~/.dsh-remote/gateway.enabled`; it can be stopped/started from the drawer.
- Token lives in `~/.dsh-remote/token` (auto-generated on first run, reused and never overwritten), shown in the drawer and copyable; supports **QR pairing** and **one-click rotation**.
- Env var `DSH_REMOTE_AUTOSTART=0` disables auto management.
- File endpoints: `/fs/list` (list directory), `/fs/file` (download with Range support), `/fs/upload` (chunked resume with pause/cancel, SHA-256 verified before writing to disk); default root is `~`, and `DSH_REMOTE_FS_ROOT` opens multiple roots (`:`-separated).

## Mobile App

The app is embedded in the plugin package (`apk/dsh-remote.apk`) — install the plugin and you have it, no GitHub needed:

- Tap **QR code** in the desktop drawer → scan it with the phone to open the admin page → download the app from that page
- Or open `http://<gateway-IP>:8787` in a browser to download
- App updates are pushed by the gateway too (`update.json` relative path), never touching GitHub
- A desktop browser opening `http://<gateway-IP>:8787` auto-enters the desktop WebUI (sidebar sessions + files + settings + stats + approval notification stack)

The app has built-in multi-server latency switching and offline chat history caching; downloaded files are stored in the system `Download/dsh-remote` folder.

## License

MIT
