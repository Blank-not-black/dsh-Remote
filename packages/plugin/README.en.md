# dsh-remote-plugin

The official DSH bundle plugin for DSH Remote. It adds a DSH sidebar entry, a compact status panel, a full admin console, and a gateway managed alongside DSH.

[English](README.en.md) · [中文](README.md)

## Install

```sh
dsh plugin --profile web add dsh-remote-plugin

# Optional version pin
dsh plugin --profile web add dsh-remote-plugin@0.6.8
```

Restart DSH Web and refresh the browser. The DSH Remote entry will appear in the sidebar.

## What the plugin provides

- Compact panel: gateway state, connected devices, token usage, and quick actions.
- Admin console: port, upstream, devices, requests, token statistics, QR pairing, and token rotation.
- Bundled `gateway.cjs`: Bearer-token gateway listening on `0.0.0.0:8787` by default.
- Self-healing lifecycle: relaunches the gateway after a DSH restart or unexpected exit; start and stop it from the panel.
- `/fs/*` file endpoints: list, download, chunked upload, resume, pause/continue/cancel, and SHA-256 verification.
- Mobile, desktop, and admin WebUI assets, plus the Android APK distributed with the plugin.

## Mobile capabilities

The Android app / mobile WebUI has five main destinations: Sessions, Files, Home, Stats, and Settings. Session detail supports goals, subagent interruption, model selection, fullscreen input, slash commands, and image attachments. Images can come from the camera or gallery and are sent as image content in `session.prompt`.

Notification settings include approval / question notifications, background polling, peak reminders, task completion notices, and announcement history. Four themes are retained: Default Deep Space, Sunset, Elbphilharmonie, and Prairie Tower.

## Gateway configuration

- Port priority: `DSH_REMOTE_GATEWAY_PORT` → `~/.dsh-remote/gateway-port` → `8787`.
- Token: `~/.dsh-remote/token`, generated on first run.
- Self-healing: `~/.dsh-remote/gateway.enabled`; use `DSH_REMOTE_AUTOSTART=0` to disable automatic management.
- File roots: `DSH_REMOTE_FS_ROOT`, separated by `:` on Linux/macOS and `;` on Windows.
- Upload limit: `DSH_REMOTE_FS_MAX_UPLOAD`, 2 GB by default.
- DSH upstream: `http://127.0.0.1:3080` by default.

The token grants remote control of DSH. Keep it private. For cross-network access, prefer Tailscale or another authenticated secure tunnel.

## Links

- Admin page: `http://<gateway-ip>:8787/admin`
- Desktop WebUI: `http://<gateway-ip>:8787`
- Main project: [dsh-Remote](https://github.com/Blank-not-black/dsh-Remote)
- Stable releases: [GitHub Releases](https://github.com/Blank-not-black/dsh-Remote/releases/latest)

## License

MIT
