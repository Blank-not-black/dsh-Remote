# harmonyos/ — DSH Remote HarmonyOS 原生客户端

`com.dshremote.app`：ArkTS/ArkUI 编写，侧载分发（HAP 自行签名安装），功能面对齐 Android 版。真机基线 MatePad Pro / 手机端双形态（<600vp Tabs 布局，≥600vp Navigation 分栏）。

## 目录内开发守则（必读）

本工程的各项开发规则、硬性约束与踩坑记录见 **[AGENTS.md](AGENTS.md)**（在本目录工作前先读，核心一条：**只用系统 ArkUI 组件与系统 SDK，零第三方运行时依赖**）。

## 仓库级文档

| 文档 | 内容 |
| --- | --- |
| [docs/modules/11-harmonyos-app.md](../docs/modules/11-harmonyos-app.md) | 模块权威文档：代码结构、逐字段契约、构建签名、真机验收、隐私清理 |
| [docs/modules/01-contracts.md](../docs/modules/01-contracts.md) | 跨端协议与数据契约（RPC/WS/HTTP，鸿蒙端不发明 RPC） |
| [docs/harmonyos-design-reference.md](../docs/harmonyos-design-reference.md) | 鸿蒙 7 官方设计/动效规范调研与本项目落点 |
| [docs/modules/README.md](../docs/modules/README.md) | 模块文档总索引与 Vibe Coding 变更规则 |

## 本机文件（不入库）

`build-profile.json5` 的 `signingConfigs`（DevEco 自动签名后本地生成）、`build.cmd`、`local.properties` 均为本机文件；克隆后先在 DevEco Studio 里完成自动签名再构建。详见 [AGENTS.md](AGENTS.md) §1.3 与模块文档 §11。
