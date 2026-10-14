# 上下文与费用：首批插件适配

> 源码核对：2026-10-12，仓库 0.7.4。下列第三方版本是已记录的接口基线，非最新版本声明。[文档首页](README.md)。


手机 Web/Android 与桌面端共用只读会话洞察；HarmonyOS 尚未移植。数据源与主机 Remote 桥接缺失时明确显示不可用。

## 入口和显示范围

打开一个会话，点击聊天顶部“更多操作”中的“上下文与费用”。手机为底部抽屉，桌面为居中的对话框；两个页签共用 `public/insights.js` 和 `insights.css`，随当前主题显示，支持中英文、键盘页签切换、Esc 关闭及焦点隔离。

- **上下文**：展示当前占用/窗口、模型、七类组成（系统提示、工具定义、用户、注入、技能、助手、工具结果）、累计压缩/裁剪/注入次数及最近八条变化。
- **费用与额度**：展示当前会话及今日 API 费用、会话含套餐等值估算、单列子代理 API 费用、官方账户余额、已开启的 Coding Plan 与 OpenCode Go 用量窗口。遵守插件的今日费用/余额隐藏配置和套餐 display/enable 开关。
- 费用使用插件账本的原始 **USD** 金额；余额使用供应商返回币种。两者不相加，也不与 Remote 的 `/stats` 相加。套餐百分比明确为已用；未提供有效数据、未安装或未查询成功时不生成假零值。
- 暂不提供价格设置、凭据编辑、预算编辑、自定义余额适配器或 CLIProxyAPI 账户面板。

## 数据契约

### dsh-context 0.64.0

优先读取当前会话 `projections.values.contextTimeline`。占用/窗口优先使用 DSH `contextPressure`，七类组成仍属于插件估算。

兼容两代投影：旧版完整投影直接读取 `events`；带 `detailRev` 的精简投影，在面板打开时 POST `/api/dsh-context/detail`，请求 `{sessionId}`，读取 `{ok:true,value:{rev,head,events,...}}`。没有投影的冷会话也尝试该明细端点。

网关对这一条精确 Fetch 路由保留 JSON 请求体，不套用新 DSH RPC envelope。原有 token/设备密钥鉴权及主机 Cookie 注入继续生效。只展示概览与事件摘要，不展示收到的系统提示词、请求内容或工具返回正文。

投影 revision 变化时在 400ms 后按需更新；旧 revision 的变化记录不会拼入新概览。失败时已有概览继续可见，并提示重试；关闭面板不再拉取明细。

### dsh-cost-meter 1.8.12

新增主机插件端点：

```
GET /remote/api/insights/cost?sessionId=<当前会话>
```

只接受一个可选 `sessionId`，长度不超过 200 且没有空白/控制字符；其他参数拒绝。插件端继续校验 Remote token；网关允许已认证控制设备读取此精确 GET 路由。POST 返回只读错误，不允许指定服务、方法或配置。

`packages/plugin/insights.mjs` 通过已加载的 `costMeter` 服务调用 `getState()` 和 `getSessionCost(sessionId)`。仅白名单提取金额、币种、日期、状态、时间戳及额度窗口，不转发插件 config、API key、请求头、供应商 URL 或错误原文。getState 请求合并并短暂缓存 15 秒；主机查询有 20 秒超时，客户端读取有 25 秒超时。

成功摘要为 `schema:1,available:true,source:'dsh-cost-meter'`，包含 `today/session/balance/plans/generatedAt`。没有服务返回 `available:false,code:'not-installed'`；服务不兼容返回 `unsupported`；查询失败只返回固定的 `cost-unavailable`。余额和套餐展示供应商查询时间，摘要时间不冒充供应商数据时间。

此费用桥接需要主机安装更新后的 Remote 插件；单独升级独立网关而没有主机 Remote 插件时，面板会明确提示缺少支持。上下文明细可通过独立网关直接代理。

## 连接与失败处理

- 打开时捕获主机、token 和 connection generation；切换主机、token 或当前会话后关闭面板并中止请求。
- 请求开始、响应到达和 body 读取后均校验身份；关闭/重开、A→B→A 或迟到响应不会污染下一次面板。
- 面板只在打开时每 60 秒更新费用摘要；上下文跟随投影并按 revision 拉取变化记录。余额刷新由费用插件自己的缓存策略负责，不调用强制刷新或配置写方法。
- 支持有效的零费用；缺失、NaN、Infinity、越界百分比及供应商错误均使用缺失/错误提示，不推断为 0。

## 历史与验证边界

[历史改动与验收记录](archive/plugin-insights-history.md)保留旧 RC/实装证据。本轮仅核对源码与全量自动测试，没有重新安装实际 profile、调用付费模型或做 Android/HarmonyOS 真机验证。
