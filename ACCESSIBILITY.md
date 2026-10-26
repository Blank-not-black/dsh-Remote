# 无障碍声明 / Accessibility

DSH Remote 希望让不同设备、输入方式和辅助技术的用户能够使用远程控制台。无障碍改进属于项目的持续维护范围；欢迎报告使用障碍并参与修复。

## 适用范围与当前验证状态

本声明覆盖手机与桌面 WebUI、Android Capacitor 客户端和 HarmonyOS 客户端。平台安装方式及差异见[使用指南](docs/usage.md)和[兼容性说明](docs/compatibility.md)。Android 客户端包含 WebView，辅助技术表现同时受系统、WebView 版本和页面实现影响；HarmonyOS 使用独立的 ArkUI 界面，应单独验证。

目前尚未完成系统性的无障碍审计，也没有覆盖全部页面的键盘、读屏、大字体、高对比度和减少动态效果验收记录。因此，本项目暂不声明满足某一无障碍符合性等级，不把一般自动化测试或构建通过视为辅助技术验证。

## 已知验证缺口

- 不同平台的键盘导航、焦点顺序、弹窗焦点恢复以及复杂菜单仍需逐项检查。
- 动态会话输出、连接状态、审批请求及错误信息是否能被读屏及时、准确地感知，尚未完整验证。
- 大字体、浏览器缩放、横竖屏、主题对比度和动画偏好下的布局及交互仍需实测。
- Android TalkBack、HarmonyOS 系统读屏及桌面浏览器读屏组合尚无完整兼容性矩阵。

以上是尚未完成验证的范围，并非对每项功能已存在缺陷的判断。具体障碍以复现和修复记录为准。

## 报告使用障碍

请使用 [Bug 表单](https://github.com/Blank-not-black/dsh-Remote/issues/new?template=bug.yml)，标题可用 `[Accessibility]`。不确定是否为缺陷时，可先在 [Discussions](https://github.com/Blank-not-black/dsh-Remote/discussions) 提问。

请尽可能说明：

- 客户端与 DSH Remote 实际版本、操作系统、浏览器或 WebView 版本。
- 输入方式与辅助技术名称、版本，以及相关的字号、缩放或显示设置。
- 出现障碍的页面、复现步骤、期望行为和实际结果。
- 可选的截图或录屏；先移除凭证、连接二维码、私有会话等敏感内容。

无需提供个人健康或残障信息。维护者会根据影响范围和可复现信息安排处理；涉及安全问题时请按[安全政策](SECURITY.md)私下报告。

## 贡献与验证

修复按[贡献指南](CONTRIBUTING.md)提交到 `dev`。说明实际测试的设备、输入方式和辅助技术，检查相关键盘及焦点行为，并在适用时提供读屏或缩放实测结果。未验证的平台明确列出；功能发生变化时同步更新本声明和相关 Issue。

We welcome accessibility reports and fixes. A complete accessibility audit and assistive-technology compatibility matrix are not yet available. Report barriers through the bug form with the affected version, environment, input method, assistive technology, and reproduction steps. You do not need to disclose health or disability information.
