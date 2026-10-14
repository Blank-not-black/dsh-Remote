# dsh-remote-plugin

The DSH bundle plugin for DSH Remote adds a sidebar entry, status panel, admin console, and a bundled gateway that respects the user's start/stop intent.

[English](README.en.md) · [中文](README.md)

## Install and connect

```sh
dsh plugin --profile web add dsh-remote-plugin@latest
dsh plugin --profile web list --depth 0
```

Use the actual profile for custom setups. DSH Desktop uses its own plugin manager and needs a complete exit/reopen. For Web, fully restart DSH Web, hard-refresh with Ctrl+F5 and open Remote in the sidebar.

On the host, open `http://127.0.0.1:8787/health`, then pair through the admin QR code. A phone connects to `http://PC-LAN-IP:8787` with its token, not its own localhost. RCs use `@next`; pin an existing version with `@<version>`.

## Capabilities and limits

- Status panel, admin console, Doctor, automatic management and explicit stop intent.
- Bearer authentication, optional per-device keys and short-lived WS tickets.
- mux/host downlinks, independent long polling, weak-network settings and local history.
- Allowed file roots, resumable chunks, hashes, previews/downloads and image attachments.
- Current-host plugin management and optional context/cost insights.
- Mobile navigation: Sessions, Files, Home, Plugins, Settings; five Web themes.
- Existing Android APKs are bundled when available; notifications/background require device permissions.
- Windows Desktop lifecycle control is experimental, needs verified instance evidence and does not configure login startup.
- HarmonyOS is a separate source project; release CI does not build HAPs. Insights and Web GenUI are not ported.
- Android ASR was removed; the feature-test page retains navigation only.

## Configuration and troubleshooting

Plugin port priority: `DSH_REMOTE_GATEWAY_PORT` → `~/.dsh-remote/gateway-port` → 8787. Bind address priority: `DSH_REMOTE_GATEWAY_HOST` → `HOST` → gateway-host file → `0.0.0.0`. The plugin passes the actual DSH upstream.

The token defaults to `~/.dsh-remote/token`; `DSH_REMOTE_AUTOSTART=0` disables automatic management. File roots, DSH workspaces and Windows defaults have specific authorization boundaries; see configuration.

For local refusal, check the actual profile, full restart and port ownership. Degraded upstream means troubleshoot DSH. For phone access, check network/firewall; for 401, pair again; for stale assets, hard-refresh. Embedded admin uses the DSH login boundary; standalone admin uses the Remote master token. A transient gateway is not necessarily a persistent systemd service.

Keep QR codes and credentials private. Prefer Tailscale across networks. Remote device/master tokens and the DSH upstream Cookie have separate roles.

## Documentation

- [Documentation index](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/README.md)
- [Installation](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/getting-started.md)
- [Configuration](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/configuration.md)
- [Troubleshooting](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/troubleshooting.md)
- [Main project](https://github.com/Blank-not-black/dsh-Remote)
- [Releases](https://github.com/Blank-not-black/dsh-Remote/releases)

Checked against repository 0.7.4 on 2026-10-12. This does not verify current npm tags, installed devices or all platform behavior. Detailed guides are currently in Chinese.

## License

MIT
