# DSH Remote

> Continue your DSH work from a phone or another computer: read sessions, answer approvals and questions, transfer files, and inspect the host.

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

DSH Remote consists of a DSH plugin, a single-file gateway, and clients. The plugin adds the DSH entry point and manages the gateway. The gateway handles authentication, HTTP/realtime proxying, and files. Clients include Android, mobile/desktop WebUI, and the HarmonyOS source project.

[Documentation](docs/README.md) · [Installation](docs/getting-started.md) · [Troubleshooting](docs/troubleshooting.md) · [Downloads](https://github.com/Blank-not-black/dsh-Remote/releases/latest) · [Issues](https://github.com/Blank-not-black/dsh-Remote/issues)

The detailed guides are currently in Chinese. This page and the plugin README provide an English overview and installation path.

The current source is **0.8.0-rc.9** (2026-10-22), a candidate for validation before the stable release. See the [rc.9 notes](docs/rc-0.8.0-rc.9.md) for scope and evidence; a local candidate does not establish npm or GitHub release availability.

## Capabilities

| Area | Features |
| --- | --- |
| Sessions | History and realtime messages, model/reasoning selection, approvals, questions, goals, queues, subagents and turn branches |
| Learning and diagnosis | Eight-step mobile guide, read-only AI diagnosis, local operation logs and feedback |
| Files and images | Host browsing, previews, downloads, resumable chunks and image attachments |
| Host status | Gateway/DSH status, mux/host channels, devices, tokens and cost estimates |
| Plugins | Installed/discovered plugins, details, configuration toggles and operation records |
| Session insights | Optional dsh-context summaries and dsh-cost-meter costs/quotas |
| Weak networks and recovery | Independent long polling, WS backoff, local history, gzip/ETag and bounded crash recovery |
| Connections and themes | Multiple pairing addresses, groups, LAN/Tailscale and six Web themes; Blue Fat Fish is the default |

Mobile navigation is **Sessions, Files, More**. The session home shows workspaces, recent sessions and items needing attention. More groups host connections, plugins, receipts and preferences. Desktop uses the same three entry points with a wider conversation layout. See [platform differences](docs/usage.md).

The [mobile guide](docs/onboarding-guided-practice.md) teaches connection, chat, files, branches, diagnosis and feedback. Finishing or skipping the entire guide removes its home invitation; reopen it at **More → Preferences and maintenance → Getting started**. Blue Fat Fish applies when no valid theme is saved; existing selections are preserved.

Image understanding depends on DSH and the model. Cost estimates do not replace provider bills. Insights require the corresponding host plugins and display unavailable states when data is missing. DSH UI renders a [safe read-only subset](docs/dsh-ui-support.md).

## Quick start: DSH Web plugin

Confirm that DSH Web works, then run as the same user:

```sh
dsh plugin --profile web add dsh-remote-plugin@latest
dsh plugin --profile web list --depth 0
```

1. Fully restart DSH Web, hard-refresh with Ctrl+F5, and open DSH Remote in the sidebar.
2. Confirm the gateway is running and open `http://127.0.0.1:8787/health` on the host.
3. Generate a connection QR in the plugin wizard or admin console and scan it in More → Hosts and connections → Scan to connect. The APK download QR only installs the app.
4. For manual pairing, use `http://PC-LAN-IP:8787` and the token. A phone's localhost refers to the phone.

The example targets the `web` profile; use your actual profile name. DSH Desktop uses its own plugin manager and requires a complete exit/reopen. Installing into Web does not install into Desktop. For a published candidate, use its exact `@<version>`; check npm before relying on `@next` or `@latest`.

For standalone gateways, multiple addresses, pinned versions and Git-source installation, see the [installation guide](docs/getting-started.md). A standalone executable can run with `--supervise`; defaults are `0.0.0.0:8787` and upstream `http://127.0.0.1:3080`.

> Pairing QR codes contain credentials. Use a trusted LAN or Tailscale; keep tokens private and avoid directly exposing the gateway to the public Internet.

## Screenshots

Captured on 2026-10-22: **rc.9 mobile WebUI** with an isolated test host and sample data, showing the default fish skin and the updated More page. These are browser captures, not Android device captures. Older emulator, desktop and admin images remain in the [screenshot archive with provenance](docs/screenshots/README.md).

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/mobile-home-0.8.0-rc.9-web.jpg" alt="rc.9 mobile WebUI home with isolated sample data" width="280"></td>
    <td align="center"><img src="docs/screenshots/mobile-more-0.8.0-rc.9-web.jpg" alt="rc.9 More page with Getting started in the preference list" width="280"></td>
  </tr>
</table>

## Downloads and platform status

[Releases](https://github.com/Blank-not-black/dsh-Remote/releases) lists versions; [Latest](https://github.com/Blank-not-black/dsh-Remote/releases/latest) is the stable entry point. RCs are separate validation releases.

| Platform | Distribution |
| --- | --- |
| Android | `dsh-remote.apk`, Capacitor shell; permissions and device behavior need device validation |
| Windows x64 | `dsh-remote-win-x64.exe`, no separate Node installation |
| Linux x64 | `dsh-remote-linux-x64`, grant executable permission |
| Browser | Connect to the gateway for mobile/desktop WebUI |
| HarmonyOS | ArkTS/ArkUI source; [build and sign yourself](docs/harmonyos-self-build.md); current release CI does not build HAPs |
| macOS Apple Silicon | CI is configured to build `dsh-remote-macos-arm64`, ad-hoc sign it and run an isolated startup smoke check; no Apple notarization. Intel uses the plugin or source; see [installation](docs/getting-started.md#独立网关) |

Documentation describes repository **0.8.0-rc.9 on 2026-10-22**. HarmonyOS still declares **0.6.26**. Check actual release attachments separately from build configuration; this page does not claim that public distribution or all device acceptance checks are complete.

Windows Desktop start/restart is experimental and requires a verified instance and trusted launch configuration. The gateway must stay online. An optional Windows login-start task for the gateway is available in the admin page and is off by default; it does not install a system service. See [configuration and limits](docs/configuration.md).

## Documentation and development

[Documentation index](docs/README.md) links installation, usage, configuration, troubleshooting, [plugin management](docs/plugin-center.md), [session insights](docs/plugin-insights.md), [development](docs/development.md), [modules](docs/modules/README.md), [compatibility](docs/compatibility.md), [release](docs/release.md), and [historical records](docs/archive/README.md).

The gateway has no runtime dependencies; the WebUI is plain JavaScript without a build step. The repository retains existing Capacitor/AndroidX and vendored browser assets. Add no new dependencies and follow [AGENTS.md](AGENTS.md). Edit root sources, then sync the plugin.

```sh
npm ci
npm run sync-plugin
npm run check
git diff --check
```

`npm run build-app` builds Android; `npm run publish` prepares local APK/update files and does not publish npm. `npm run release <version>` stages all non-ignored changes, commits, pushes and updates the tag; it requires the release scope to be accepted. Its `--dry-run` still writes local version files.

## Contributors and thanks

The offline credits list includes [Blank-not-black](https://github.com/Blank-not-black), [wikkd](https://github.com/wikkd), [anupamme](https://github.com/anupamme), and [liuchang-t](https://github.com/liuchang-t). See [GitHub Contributors](https://github.com/Blank-not-black/dsh-Remote/graphs/contributors) for the full history. This list is not a newly queried contribution ranking.

## License

[MIT](LICENSE)
