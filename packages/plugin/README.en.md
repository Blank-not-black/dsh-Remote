# dsh-remote-plugin

The DSH bundle plugin for DSH Remote adds a sidebar entry, status panel, admin console, and a bundled gateway that respects the user's start/stop intent.

[English](README.en.md) · [中文](README.md)

## Install and connect

```sh
dsh plugin --profile web add dsh-remote-plugin@latest
dsh plugin --profile web list --depth 0
```

Use the actual profile for custom setups. DSH Desktop uses its own plugin manager and needs a complete exit/reopen. For Web, fully restart DSH Web, hard-refresh with Ctrl+F5 and open Remote in the sidebar.

On the host, open `http://127.0.0.1:8787/health`, then display a connection QR in the plugin wizard or admin console. Scan it at More → Hosts and connections → Scan to connect; the APK download QR only installs the app. A phone connects to `http://PC-LAN-IP:8787` with its token, not its own localhost. Pin a published version with `@<version>`; check the actual `@next` and `@latest` tags separately.

## Capabilities and limits

- Status panel, admin console, Doctor, automatic management and explicit stop intent.
- Bearer authentication, optional per-device keys and short-lived WS tickets.
- mux/host downlinks, independent long polling, weak-network settings and local history.
- Allowed file roots, resumable chunks, hashes, previews/downloads and image attachments.
- Current-host plugin management and optional context/cost insights.
- Mobile navigation: Sessions, Files, More; six Web themes, defaulting to Blue Fat Fish while preserving existing choices.
- Eight-step mobile guide; finishing or skipping the entire guide removes its home invitation. Replay at More → Preferences and maintenance → Getting started.
- rc.9 includes cold-session recovery and error-attribution fixes, send-result diagnostics, and upload/branch recovery validation; see the candidate notes for scope.
- Existing Android APKs are bundled when available; notifications/background require device permissions.
- Windows Desktop lifecycle control is experimental and needs verified instance evidence. Optional gateway login startup is available in admin, off by default; no system service is installed.
- HarmonyOS is a separate source project; release CI does not build HAPs. Insights and Web GenUI are not ported.
- The Android ASR bridge and empty feature-test entry were removed; notification tests are in advanced notification options.
- macOS can run the plugin's gateway source. Main release CI is configured for an Apple Silicon standalone gateway, ad-hoc signing and startup smoke checks; it does not notarize with Apple.

## Configuration and troubleshooting

Plugin port priority: `DSH_REMOTE_GATEWAY_PORT` → `~/.dsh-remote/gateway-port` → 8787. Bind address priority: `DSH_REMOTE_GATEWAY_HOST` → `HOST` → gateway-host file → `0.0.0.0`. The plugin passes the actual DSH upstream.

The token defaults to `~/.dsh-remote/token`; `DSH_REMOTE_AUTOSTART=0` disables automatic management. File roots, DSH workspaces and Windows defaults have specific authorization boundaries; see configuration.

For local refusal, check the actual profile, full restart and port ownership. Degraded upstream means troubleshoot DSH. For phone access, check network/firewall; for 401, pair again; for stale assets, hard-refresh. Embedded admin uses the DSH login boundary; standalone admin uses the Remote master token. A transient gateway is not necessarily a persistent systemd service.

Keep QR codes and credentials private. Prefer Tailscale across networks. Remote device/master tokens and the DSH upstream Cookie have separate roles.

## Documentation

- [Documentation index](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/README.md)
- [Installation](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/getting-started.md)
- [rc.9 changes and validation scope](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/rc-0.8.0-rc.9.md)
- [Getting started guide](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/onboarding-guided-practice.md)
- [Configuration](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/configuration.md)
- [Troubleshooting](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/troubleshooting.md)
- [Main project](https://github.com/Blank-not-black/dsh-Remote)
- [Releases](https://github.com/Blank-not-black/dsh-Remote/releases)

Checked against repository 0.8.0-rc.9 on 2026-10-22. This does not verify current npm tags, installed devices, public assets or all platform behavior. Detailed guides are currently in Chinese.

## License

MIT
