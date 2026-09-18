# HarmonyOS 7（API 26.0.0）设计风格与动效参考索引

> 目的：汇总鸿蒙 7 一代（开发套件 26.0.0）官方设计/动效规范的调研结论与文档出处，作为鸿蒙客户端（`harmonyos/`，见 [11-harmonyos-app.md](modules/11-harmonyos-app.md)）UI 演进的设计基准。
>
> 调研时间：2026-09-17，基于本地官方文档镜像（`harmonyos-docs` MCP，16.8k 篇）+ 官方站在线核对。所有链接均为华为开发者官方 url。

## 1. 版本口径

- 「鸿蒙 7」对应的开发套件版本是 **26.0.0**：HDC.2026 发布 Beta1（2026-06-12），2026-08-29 正式 Release。从该版本起版本号弃用 `X.Y.Z(N)` 格式，改为纯语义化版本（SemVer）。
- 近期 API 版本大小关系：`26.0.0 > 6.1.1(24) > 6.1.0(23) > 6.0.2(22) > …`
- 兼容性要点：设备能用的 API 由 ROM 决定；应用能装到哪些设备由 `compatibleSdkVersion` 决定；应用使用新 API 需条件判断保护（如 `canIUse`）。
  - 本工程 `build-profile.json5`：`targetSdkVersion: 26.0.0` + `compatibleSdkVersion: 6.1.1(24)`。
  - 现有真机（MatePad）系统 API 版本为 **24**（`hdc shell param get const.ohos.apiversion`）→ API 26 专属能力（沉浸材质、UIMaterial 等）在真机上不可用；`curves.springMotion` 等物理曲线为 API 9/10 能力，不受限。

| 文档 | url |
| --- | --- |
| 版本概览 | https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/overview-2600 |
| 版本号格式调整说明 | https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/version-number-26 |
| 应用兼容性说明 | https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/app-compatibility-intro |

## 2. 设计风格：HDS + 沉浸光感

设计语言仍是 **HDS（HarmonyOS Design System）**，理念三关键词：

- **One（人因）**：以人为本，文字/图标/色彩/动效基于人因研究，直觉操作。
- **Harmonious（光影材质）**：把物理世界的光影、材质映射进界面——26.0.0 的风格主线。
- **Universe（多设备）**：一套界面自适应多设备，一致性与差异性平衡。

**26.0.0 主线 = 沉浸光感材质**：

- 系统材质：Dialog/Toast/AlphabetIndexer/文本选择菜单默认开启沉浸式系统材质（仅 targetSdk≥26 且系统为 26 生效）；应用自设背景色/模糊/阴影会覆盖默认材质，可通过 `ohos.arkui.UIMaterial.state=disable` 全局关闭、`uiMaterial.Material.empty` 组件级关闭。
- UI Design Kit（`@kit.UIDesignKit`，HDS 官方扩展组件集）：HdsNavigation（动态模糊标题栏）、HdsSideBar/HdsSideMenu、HdsTabs（浮动页签+模糊+图标出血）、HdsSnackBar、HdsActionBar、HdsListItem（高端卡片+横滑删除）、HdsColorPicker、MultiWindowEntryInAPP。
- HDS 视效：点光源、边缘/背景流光、按压阴影（按压时自动计算背景色变化）、标题栏/底部页签沉浸光感材质（`hdsMaterial`，6.1.0(23)+ 起支持，材质效果按设备算力 ADAPTIVE 自适应）。
- **引入约束**：UI Design Kit 仅支持中国境内；模拟器不支持 HDS 视效；且与本项目零依赖基调不符——现阶段不引入，自绘令牌体系（`models/Theme.ets`）保留。

| 文档 | url |
| --- | --- |
| 设计理念 | https://developer.huawei.com/consumer/cn/doc/design-guides/design-concepts-0000001795698445 |
| HDS 组件设计规范总览（各组件设计指南入口） | https://developer.huawei.com/consumer/cn/doc/design-guides/general_overview-0000001929599380 |
| UI Design Kit 简介 | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ui-design-introduction |
| 沉浸光感（hdsMaterial） | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ui-design-hds-component-material |
| 26.0.0 UX 样式变更（材质默认开启/热区/文本优化等） | https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/changelogs-ux-7001 |
| 应用 UX 体验建议（质量检查项总表） | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/experience-suggestions-ux |

## 3. 动画风格：物理曲线优先 + 语义化转场

**曲线基调**（官方明确建议优先物理弹簧曲线，贝塞尔仅辅助）：

| 曲线 | 用途 | 可用性 |
| --- | --- | --- |
| `curves.springMotion(response, dampingFraction)` | 通用弹性动画；时长由弹簧参数自动算，到终点速度自然归零；新动画自动继承旧动画速度状态 | API 9+，真机可用 |
| `curves.responsiveSpringMotion` | 跟手场景（拖拽/滑动手势），离手用 springMotion 衔接、速度无缝继承 | API 9+，真机可用 |
| `curves.interpolatingSpring(velocity, mass, stiffness, damping)` | 需指定初速度的场景（甩动等）；时长自动计算 | API 10+，真机可用 |
| `curves.springCurve` | 破坏曲线物理规律（时长映射拉伸），官方不建议 | — |
| 传统曲线（`Curve.FastOutSlowIn` / cubicBezier 等） | 极少数必要场景的辅助 | API 7+ |

**转场语义化**（UX 体验建议的硬性检查项）：

| 场景 | 官方规定的运动方式 |
| --- | --- |
| 层级进入（进子页） | 左右位移 |
| 新建/创建 | 上下位移 |
| 编辑态 | 淡入淡出 |
| 搜索 | 共享元素转场（一镜到底） |

ArkUI 转场分类：出现/消失转场（`transition`）、模态转场（bindSheet 等）、共享元素转场、旋转屏动画、导航转场（`pageTransition` 不推荐，优先导航/模态转场）。

**其他硬性 UX 指标**：点击热区 ≥40×40vp；色彩最小对比度；最小字号；界面滑动过界需反馈动效；离手减速动效一致；窗口宽度 ≥840vp 时底部导航应切换为侧边导航；效率型应用用分栏布局（本项目平板 Navigation 分栏符合）。

| 文档 | url |
| --- | --- |
| 动画曲线概述 | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-curve-overview |
| 弹簧曲线 | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-spring-curve |
| 传统曲线 | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-traditional-curve |
| 转场动画概述 | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-transition-overview |
| 共享元素转场（一镜到底） | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-shared-element-transition |

## 4. 对本项目的落点（行动索引）

**已对齐**：平板 Navigation 分栏（≥600vp 断点）、悬浮胶囊底部导航、侧边栏工作区分组、自绘令牌体系（`models/Theme.ets`）。

**可低成本落地**（真机 API 24 即可用）：

1. 现有固定时长 `animateTo`（分组折叠 280ms `Curve.Friction` 等）→ 换 `curves.springMotion()`，零依赖获取系统手感。
2. 按压反馈：卡片/按钮加 `scale` 0.95→1 的 spring 动画，贴近「按压物理感」（替代单纯 shadow 变化）。
3. 转场语义对齐：Navigation push 默认左右位移已符合层级语义；新建类弹层用上下位移、编辑态用淡入淡出。

**暂不引入**：UI Design Kit（HdsXxx 组件）、systemMaterial/沉浸光感（API 26 专属，真机 24 无效；待系统升级 26 后再评估）。
