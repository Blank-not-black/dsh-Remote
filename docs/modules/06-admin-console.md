# 网关管理控制台模块

> 状态：现行运维模块
>
> 源码：`public/admin.html`、`public/admin.js`
>
> 访问：独立网关 `/admin/`；插件模式 `/remote/admin/`

## 1. 模块定位

管理控制台面向维护者，负责确认网关是否运行、主机地址如何连接、哪些设备在线、token/设备密钥如何管理以及出现问题时如何诊断。它不承担普通会话操作。

## 2. 代码结构

- `admin.html`：状态卡、Doctor、设备表、统计、二维码区域、反馈/主题/登录 UI 和中英文本。
- `admin.js`：API 模式判断、状态加载、Doctor、设备密钥、统计、二维码和操作绑定。
- `API`：插件模式使用 `/remote/admin/api`，独立模式使用 `/admin/api`。

## 3. 当前功能

- 独立网关 token 登录和插件内嵌免重复登录。
- DSH、网关、网络、防火墙、设备和实时链路 Doctor 检查。
- 网关启动/停止、端口显示、上游状态、版本/更新和运行数据。
- 设备在线列表、备注、踢下线、独立设备密钥开关/生成/轮换/撤销。
- Token 统计、反馈、主题和配对二维码。
- 主机 IP 大模块合并自动枚举、环境变量声明和手动添加的宿主地址；用户可逐项启用/关闭，启用集合用于二维码、Doctor 和防火墙建议。

## 4. 具体实现方式

`loadState()` 从当前 API 获取 `mode`、`lanIPs`、`port`、`events`、`devices` 和能力声明。网关不可用时，插件 Node half 返回能力受限的 fallback，页面必须明确显示“网关未运行”，不能伪造设备或实时状态。

`buildDoctorChecks()` 将状态转成用户可执行的检查项；网络项只使用可连接的 LAN 地址，实时项同时要求 mux/host connected。`renderDoctor()` 只负责显示结论和下一步动作。

`normalizedHostIPs()` 合并 `st.lanIPs` 与按主机身份隔离的手动地址，校验、去重并排除 loopback/0.0.0.0；`enabledHostIPs()` 从 `localStorage` 偏好中恢复启用集合，默认全部启用且至少保留一个地址。手动地址用于容器无法枚举宿主网卡的场景。`pairTarget()` 只把启用地址构造成多个 `http://host:port`，用 `URLSearchParams.append('server', base)` 生成配对 URL；保留 `base` 作为首地址供提示/复制按钮使用。

插件模式的 `adminHeaders()` 不写 Remote Bearer `Authorization`，让浏览器保留 Caddy 等反向代理的 Basic 凭据；独立网关模式才写 Bearer。插件 API 返回 401 或非 JSON 登录页时显示认证层错误，不执行 Remote token 退出流程。

设备密钥二维码使用当前 entry token，但地址仍来自同一套 `pairTarget()`，确保共享 token 和独立设备密钥都能导入全部主机地址。

## 5. 制作目的

- 把“网关没启动、上游不可达、手机无法连接、实时未恢复”拆成可行动诊断。
- 让多网卡主机的连接信息一次性完整传给 App。
- 提供令牌和设备管理，而不是让用户通过手工编辑文件维护凭证。
- 把复杂运维信息集中在维护者页面，保持手机主页和插件面板简洁。

## 6. 关键契约

管理状态至少包含：`mode`、`version`、`host`、`port`、`lanIPs`、`upstream`、`events.mux/host`、`deviceKeys`、`devices` 和能力声明。新增字段必须考虑 plugin fallback 的默认值。

二维码只传递配对所需的 token 与 server，不把设备列表、上游地址、统计或诊断细节写入二维码。

## 7. 边界与禁止事项

- 不把第一个 LAN IP 当作完整地址集合；二维码必须遍历启用的 `lanIPs`，默认集合仍包含全部地址。
- 不把防火墙建议中的单一 CIDR 误当成二维码地址列表；两者用途不同。
- 不直接编辑插件副本的 `admin.js`/`admin.html`。
- 不在页面显示完整 token 以外泄露设备密钥，复制/二维码操作需保持现有权限边界。
- 不把 UI 的 pass/warn 颜色当作实时协议本身，数据来源必须清楚。

## 8. 测试与验收

- `tests/doctor-ui.test.js`：Doctor 结构和安全动作。
- `tests/device-keys-ui.test.js`、`tests/device-keys.test.js`：设备密钥 UI/API/持久化。
- `tests/network-regression.test.js`：二维码多 IP 生成、启用地址筛选、App 多 IP 导入和旧二维码兼容。
- `tests/user-flows.test.js`：管理页设备状态、备注和踢下线。
- 人工验收要在多网卡环境确认地址表默认全选；关闭虚拟机地址后，二维码和 Doctor/防火墙建议不再使用它，并可切换到仍启用的非首地址连接。

## 9. 修改前检查清单

- 是管理展示、网关 API，还是客户端协议变化？
- plugin fallback 是否仍能渲染？
- `lanIPs` 为空、只有 loopback、包含重复值时是否合理？
- QR payload 是否可能超过容量，是否需要压缩或限制？
- 是否更新管理端和手机端的结构/行为测试？

## 10. 未决事项

- 当前复制地址按钮仍复制首选地址；“复制全部地址”如果需要，应作为独立 UI 需求，不改变二维码契约。
