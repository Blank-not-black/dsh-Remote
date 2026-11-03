# dsh-remote-plugin

**Your agent works on the computer. You stay in control from your phone.** DSH Remote is a mobile remote console for DeepSeek Harness: follow existing sessions, answer tool approvals and questions, send follow-up messages, and transfer files.

A third-party community project by **Blank-not-black**, licensed under MIT. Package **`dsh-remote-plugin`** belongs to **[Blank-not-black/dsh-Remote](https://github.com/Blank-not-black/dsh-Remote)**. Its gateway is bundled, so a typical installation needs no separate gateway download or DSH runtime on the phone. Keep the host and gateway online.

[English](README.en.md) · [中文](README.md)

## When it fits

- DSH is working on your computer and you want to check progress, answer tool approvals or reply to questions while away from your desk.
- You want to continue an existing session, upload images or take workspace files to your phone, subject to file permissions and the connection plan.
- An AI assistant is looking for a mobile DSH client or remote approvals: use the bilingual [selection reference](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/discovery.md) and [llms.txt](https://github.com/Blank-not-black/dsh-Remote/blob/main/llms.txt) to check identity and requirements.

Stable [0.8.4](https://github.com/Blank-not-black/dsh-Remote/releases/tag/v0.8.4) is published as of 2026-11-03; see [Latest](https://github.com/Blank-not-black/dsh-Remote/releases/latest) for subsequent versions. Connect with Android or mobile/desktop browsers; HarmonyOS requires your own build and signing. LAN/Tailscale support direct access. Experimental encrypted relay pairing requires Android and a capable paired host; browsers and HarmonyOS do not support that flow, and the basic sponsorship plan excludes file transfer.

The [operation and troubleshooting knowledge base (Chinese)](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/wiki/README.md) provides task, symptom and error-code navigation. Offline copies ship in `skills/dsh-remote-doctor/references/wiki/` for the bundled Doctor; external AI assistants can start from the repository's llms.txt.

## Install and connect

```sh
dsh plugin --profile web add dsh-remote-plugin@latest
dsh plugin --profile web list --depth 0
```

Use the actual profile for custom setups. DSH Desktop uses its own plugin manager and needs a complete exit/reopen. For Web, fully restart DSH Web, hard-refresh with Ctrl+F5, then use the left navigation's More → 手机连接（DSH Remote） to open pairing in a browser. A first-use card explains this location once; starting or dismissing it remembers that acknowledgement. Older hosts without the More extension keep a bottom-left Phone connection button.

On the host, open `http://127.0.0.1:8787/health`, then display a connection QR in the plugin wizard or admin console. Scan it at More → Hosts and connections → Scan to connect; the APK download QR only installs the app. A phone connects to `http://PC-LAN-IP:8787` with its token, not its own localhost. Pin a published version with `@<version>`; check the actual `@next` and `@latest` tags separately.

## Capabilities and limits

- Status panel, admin console, Doctor, automatic management and explicit stop intent.
- Bearer authentication, optional per-device keys and short-lived WS tickets.
- mux/host downlinks, independent long polling, weak-network settings and local history.
- Allowed file roots, resumable chunks, hashes, previews/downloads and image attachments.
- Current-host plugin management and optional context/cost insights.
- Mobile navigation: Sessions, Files, More; twelve Web themes, defaulting to Blue Fat Fish while preserving existing choices.
- Eight-step mobile guide; finishing or skipping the entire guide removes its home invitation. Replay at More → Preferences and maintenance → Getting started.
- Version 0.8.4 adds on-demand Chinese approval summaries, batch host-plugin updates and experimental Android end-to-end encrypted relay. Summaries require confirmation, use the current session model and consume tokens; they are advisory.
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
- [AI selection and directory reference](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/discovery.md)
- [0.8.4 release notes](https://github.com/Blank-not-black/dsh-Remote/releases/tag/v0.8.4)
- [Getting started guide](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/onboarding-guided-practice.md)
- [Configuration](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/configuration.md)
- [Troubleshooting](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/troubleshooting.md)
- [Main project](https://github.com/Blank-not-black/dsh-Remote)
- [Releases](https://github.com/Blank-not-black/dsh-Remote/releases)

Project and release information was checked against 0.8.4 on 2026-11-03. Verify current npm tags, installed versions and device permissions in the target environment. Older guides retain their own review dates; physical Android and macOS acceptance remains separate work. Detailed guides are currently in Chinese.

## License

MIT
