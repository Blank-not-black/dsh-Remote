# harmonyos/ — HarmonyOS 原生客户端开发守则

> 本目录是 `com.dshremote.app`（ArkTS/ArkUI，侧载分发）的 DevEco 工程。仓库级守见根
> [AGENTS.md](../AGENTS.md) 与[模块文档与开发规范](../docs/modules/README.md)；本文件是**目录内的落地细则**——在本目录及其子目录工作时，以下规则同样是硬性约束，违反即返工。

## 1. 硬性约束

1. **零第三方运行时依赖（最重要的红线）**
   - `oh-package.json5` 的 `dependencies` 恒为 `{}`；不引任何 ohpm 第三方 har 包。
   - UI 一律使用**系统 ArkUI 组件**（`Button` / `Toggle` / `AlertDialog` / `Text` / `Column` 等）与自绘组件；缺的能力（空态、弹窗、反馈）对照已有自绘实现照样式补，不找库。
   - 仅允许 `devDependencies` 里的 `@ohos/hypium`（测试）与 `@ohos/hamock`（mock）——DevEco 模板自带、不进 HAP。
   - **教训（PR #12，勿重蹈）**：曾引入 `@ibestservices/ibest-ui-v2` 并实际用于发送按钮/开关/空态。代价：整库 har 打进 HAP（ArkTS 无 tree-shaking，四五十个未用组件全部进包）、要求 `IBestInit` 全局初始化、状态管理 V2（`@ComponentV2`/`@Param`）混入本项目 V1 页面、自带主题与 `models/Theme.ets` 令牌体系冲突。实际换来的只是省几行样式代码。已于评审后整体移除（manifest/锁文件/oh_modules/代码零残留）。**不要再以"方便""后续替换自研组件"为由引入任何第三方库。**
2. **不发明 DSH RPC**：以 [01-contracts.md](../docs/modules/01-contracts.md) 和 DSH Web 端可见行为为准；跨端契约变更必须同步登记 `01-contracts.md`，网关侧配合改动必须同步 `02-gateway.md`。
3. **入库与隐私（`git add` 前必查）**：`build-profile.json5` 的 `signingConfigs` 必须为空数组、products 不引用签名配置（本地自动签名材料用 `git update-index --skip-worktree` 保护）；`build.cmd`、`local.properties` 不入库（见 `.gitignore`）；token/API key 只存设备 preferences，不进日志/仓库。
4. **提交纪律**：跟随仓库惯例——改动不提交，攒到 release 由 `npm run release` 统一 `git add -A` 提交；所以第 3 条的清理必须在**写代码时**就位，不能指望提交前补救。
5. **改完必须回填文档**：行为/文件/契约变化写进 [docs/modules/11-harmonyos-app.md](../docs/modules/11-harmonyos-app.md)（代码结构表、功能表、变更记录），未决定的能力写「未决事项」，不得冒充已支持。

## 2. 工程结构与文档

- 模块权威文档：[docs/modules/11-harmonyos-app.md](../docs/modules/11-harmonyos-app.md)（页面/服务清单、契约逐字段实测、构建签名、真机验收清单、隐私清理表）。
- 设计基准：[docs/harmonyos-design-reference.md](../docs/harmonyos-design-reference.md)（鸿蒙 7 官方设计/动效调研；**UI Design Kit 因零依赖基调不引入**，沿用自绘令牌体系）。
- 代码分层：`entry/src/main/ets/` 下 `pages/`（手机 @Entry）+ `pages/tablet/`（≥600vp 分栏）+ `components/` + `models/`（Theme/SessionView 等纯数据）+ `services/`（GatewayApi/Realtime/FsUpload/AppState/Storage…）+ `common/`（I18n/AppNav/确认弹窗等共享逻辑）。
- 主题与状态：一切颜色经 `models/Theme.ets` 令牌（`Design.*`），深色/强调色不得写死 hex；跨服务状态走 AppStorage 原语 + `@StorageLink`；**@Builder 按值传参不建立渲染依赖**，动态值用闭包（踩过的坑，详见仓库 memory）。

## 3. 构建与验证

- 构建：DevEco Studio 或 `hvigorw`（见 `build.cmd`，本机文件）；产物 `entry/build/default/outputs/default/*.hap`；签名用 DevEco 自动签名（本地物料，不入库）。
- **改动媒体资源（`resources/base/media/` 增删文件）后必须先删 `entry/build/default/intermediates` 再构建**：hvigor 增量构建可能复用旧资源索引而字节码用新 ID 表，产生图标按资源 ID 整体错位渲染的坏包（2026-09-19 实测：底部导航全部显示成 ID-2 的邻居图标；卸载+清缓存全量重建+重装恢复）。
- 最低门禁（涉及网关/JS 联动时）：`npm run sync-plugin` + `npm run check` + `git diff --check`（仓库根执行）。
- **真机行为不能由静态构建结果代替**：通知、相机、后台限制、弱网恢复、深色切换须逐项真机记录。验证分工：构建 + `hdc install -r` 装机 → 用户真机体验；功能性行为（数据正确性、开关回退）逐项验证。
- 已知真机坑：平板断点媒体查询须在窗口布局完成后注册（`aboutToAppear` 用页面自身 UIContext 重注册）；USB 反向隧道 `usb-tunnel.cmd` 用于 AP 隔离环境联调；hdc 传文件注意 MSYS 路径转换。
