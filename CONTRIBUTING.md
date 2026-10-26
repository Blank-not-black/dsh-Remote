# 贡献指南 / Contributing

欢迎提交问题、修复、文档和使用体验建议。中文和英文均可。参与前请阅读[社区行为准则](CODE_OF_CONDUCT.md)；使用问题见[支持指南](SUPPORT.md)，安全漏洞见[安全政策](SECURITY.md)，无障碍范围与反馈方式见[无障碍声明](ACCESSIBILITY.md)。

Contributions in Chinese or English are welcome. Target ordinary pull requests at **`dev`**. Read the project constraints below and describe what you actually tested.

## 分支与 Pull Request

| 分支 | 用途 | 合入方式 |
| --- | --- | --- |
| `main` | 发布主线，保留为 GitHub 默认分支 | 维护者将验收通过的 `dev` 合入；紧急修复可单独处理 |
| `dev` | 日常开发与下一版本集成 | 普通功能、修复和文档 PR 的目标分支 |
| 短期任务分支 | 一项功能或修复 | 从 `dev` 创建，完成后提 PR 到 `dev` |

1. 搜索已有 Issue/PR；较大功能先在 Issue 说明场景和范围。
2. Fork 仓库，从最新 `dev` 创建任务分支，例如 `feat/file-preview`、`fix/reconnect`、`docs/setup`；Codex 创建的任务分支使用 `codex/` 前缀。
3. 每个 PR 聚焦一个问题，说明变更前后的行为、验证结果和未覆盖的平台。界面改动附截图或操作录屏。
4. 创建 PR 时检查 **base 为 `dev`**。GitHub 默认分支仍为 `main`，不要直接接受默认目标。
5. 修订通过后由维护者合入；合并 PR 不等于发布。维护者在集成验证和 RC 验收后将 `dev` 合入 `main`，再按[发布指南](docs/release.md)发布。

紧急修复从 `main` 创建分支、PR 到 `main`，随后由维护者将修复同步回 `dev`。避免长期维护两份不同修复；发布后也应把 `main` 的版本和产物提交合回 `dev`。

维护者和 AI 的日常开发在 `dev` 或对应任务分支进行，允许按任务形成较小提交并推送 GitHub，便于及时保存和审查；推送开发代码不等于发布。用户明确要求不提交时保留本地改动。部署、合入发布主线和发布标签仍需明确授权。外部贡献者通过自己的分支提交 PR。

## 开发边界

开始前阅读 [AGENTS.md](AGENTS.md) 和[开发指南](docs/development.md)。涉及 HarmonyOS 时还需阅读 [harmonyos/AGENTS.md](harmonyos/AGENTS.md)。

- 不新增第三方依赖、运行时 HAR 或 CDN 脚本；网关保持单文件，WebUI 保持零构建纯 JavaScript。
- 修改根 `public/` 和 `gateway.js` 后执行 `npm run sync-plugin`。不要手改插件中的前端与网关同步副本。
- 先检查工作区，保留已有改动。不要把本机配置、缓存、凭证、签名材料或无关构建文件混入 PR。
- 测试使用临时目录、隔离的 HOME/USERPROFILE/DSH_HOME/`DSH_REMOTE_FS_ROOT` 和固定测试 TOKEN，清理代理变量及子进程；不要接触真实 `~/.dsh-remote`。
- AI 辅助代码与人工代码遵循相同要求。提交者需理解并验证变更，说明重要限制，不把生成结果或未执行的测试写成已验证。

## 验证与提交说明

CI 使用 Node.js 22。首次准备环境运行 `npm ci`；源码修改后按需同步，并执行：

```sh
npm run sync-plugin
npm run check
git diff --check
```

纯文档修改无需同步插件或构建 APK，但应检查链接、命令和表述。代码改动补充能复现问题的相关测试；界面和设备行为需要对应的浏览器或真机验证。报告实际通过、失败、跳过的结果，以及没有验证的平台。

PR 标题直接说明改动，例如 `fix: 网络切换后恢复会话历史`。正文说明问题、方案和验证；未完成工作使用 Draft PR。不要为普通贡献运行 `npm run release`、推送 tag 或发布包；`npm run publish` 在本项目中仅准备本地产物，也会修改文件。

## 发布和仓库设置

当前发布脚本仅允许从 `main` 执行实际发布；`--dry-run` 可在其他分支使用，但仍会写本地版本文件。发布前必须确认 `git add -A` 的完整范围。RC、正式版、分发核验均按[发布指南](docs/release.md)执行。

社区文档、Issue 表单和工作流需提交并合入相应分支后才会在 GitHub 生效。分支保护是 GitHub 仓库设置，文档本身不会启用保护。维护者应在相关 CI 已运行、检查名称可选后，为 `main` 和 `dev` 配置经 PR 合入、必需检查及禁止强制推送/删除；为现有发布脚本保留维护者明确控制的发布通道，避免要求本人批准自己的 PR。

## 许可证

贡献按仓库现有 [MIT License](LICENSE) 提供。引用第三方内容时保留原有许可证与署名，不引入授权不清楚的素材。
