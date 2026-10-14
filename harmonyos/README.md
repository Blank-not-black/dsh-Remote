# DSH Remote HarmonyOS 客户端

`com.dshremote.app`：系统 ArkTS/ArkUI 工程，支持手机与宽屏分栏，侧载 HAP 需自行签名。当前工程版本为 `0.6.26` / `6269`，与根项目 `0.7.4` 分开维护；当前 GitHub 发布工作流不构建 HAP。

| 文档 | 内容 |
| --- | --- |
| [自构建与签名](../docs/harmonyos-self-build.md) | 工具链、构建、签名、安装及真机门禁 |
| [目录守则](AGENTS.md) | 修改本工程前必读，系统组件/SDK、零第三方运行时依赖 |
| [客户端模块](../docs/modules/11-harmonyos-app.md) | 当前结构、能力、契约与未移植范围 |
| [协议契约](../docs/modules/01-contracts.md) | HTTP/WS/RPC、文件、配对与认证 |
| [客户端平台差异](../docs/usage.md) | Android/Web/HarmonyOS 的实际边界 |
| [历史记录](../docs/archive/harmonyos-development-history.md) | 旧构建、实机验证和平台问题 |
| [设计调研](../docs/harmonyos-design-reference.md) | 日期化参考，不能代替当前设备验证 |

鸿蒙保留独立 ASR 诊断、四套主题和自身后台实现；Web 的会话洞察、GenUI 和历史缓存没有自动对齐。本轮只核对文档与源码，未构建、签名或安装 HAP。

`build.cmd`、`local.properties` 与个人签名材料不入库。IDE 生成的 `build-profile.json5` 签名配置属于本机内容，仓库版本保持空签名数组。
