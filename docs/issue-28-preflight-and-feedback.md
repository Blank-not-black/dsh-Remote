# issue #28 修复与近期反馈复核

2026-10-30；基于 `dev` 的独立开发分支。未部署、未发布，未更改版本号；原工作区的主题与图片缓存改动不属于本次提交。

## 修复

[issue #28](https://github.com/Blank-not-black/dsh-Remote/issues/28) 与 10 月 29 日收集器报告指向同一链路：默认 1440 分钟发布年龄策略触发整个锁文件扫描，任一包的完整元数据超过 8 MiB 就在任务创建前失败。

[npm 官方元数据说明](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md) 中，`application/vnd.npm.install-v1+json` 的顶层字段没有 `time`。因此本次保留完整 JSON 请求，改用流式投影：校验完整结构及字符串转义，只保留顶层 `name/time`，不累积 README、依赖及各版本安装清单。名称不符、重复的保留字段、无效 UTF-8、损坏 JSON 和发布时间缺失都不能放行。

单包读取上限 64 MiB，保留字段上限 1 MiB 字符、JSON 最大深度 64，单请求 20 秒。响应失败、超限或取消时释放读取器；错误包含包名、已接收字节数，超限还包含限制值。普通详情接口保留 8 MiB 上限，也补充了路径与字节数。成功的发布时间仍缓存 5 分钟、最多 1500 个包。

整个锁文件检查是现有事务约定，不能仅为解决文档大小而省略无关依赖，也不修改用户的 `minimumReleaseAge`。仍以 6 并发检查；整体预算从固定 20 秒改为按批次数增长，上限 120 秒。前端和网关仅对 `/remote/api/plugins/preflight` 预留 130 秒，其他插件请求保持原限制。

## 反馈复核

只读检查收集器现有 168 条记录，其中 10 月 20 日以来 65 条：60 条投票、5 条 bug。未复制联系方式、IP 或原始诊断附件到仓库，未发送回复、关闭 issue 或修改服务器。

| 记录 | 复核结果 |
| --- | --- |
| 10-20，0.8.0-rc.4，重启后断连 | 描述不足，不能确定连接路径、错误或是否仍存在；没有据此调整重启策略。 |
| 10-21，0.8.0-rc.8，发送结果未确认 | 当前代码已有收据 `diagnostic`，提供上游状态/错误类别/阶段/耗时；未知结果提示可能已生效、先核对，图片处理失败有明确拒绝原因。原报告没有新版本复验。 |
| 10-24，0.8.0-rc.8，无法软件内更新 | 旧版本报告缺少安装日志，不能确认与 #28 同因；当前已有自更新目录锁、独立 worker 和事务恢复回归。 |
| 10-26，0.8.1，公告反复弹出 | 当前已有存储失败兜底、持久化诊断及缓存维护代码；本次不改动另一分支的缓存工作。 |
| 10-29，0.8.1，Registry response too large | 与 #28 重复，本次修复。 |

GitHub 开放 issue 和评论另行复核：#21 已由报告者在 macOS 确认两条接管路径通过；#22 已确认新版本不再卡死；#19 修复后仍待 Windows 原机确认；#18 的 Remote 容错已有实现，上游迁移与 WebView 无障碍仍未完成原场景复验；#23 无新增手机端诊断；#11 是待上游删除接口确认的功能需求。本次不将缺少证据的状态标为修复完成。

## 验证

- `npm run sync-plugin` 已同步网关、插件页面与构建指纹。
- 定向回归 73 项：72 通过、1 项平台跳过、0 失败。包括大于 8 MiB 元数据的真实预检、版本年龄阻塞、缺失版本拒绝、逐字节分块、转义和嵌套诱饵、非法 JSON/UTF-8、HTTP/取消、两类大小限制、182 个包的预算及失败取消；实际网关进程验证预检能超过普通上游超时，其他路由仍超时退出。
- 全量 `npm run check`：1091 项，1071 通过、20 跳过、0 失败。首次沙箱执行的两项 Windows supervisor 身份查询被拒，允许系统查询后全量重跑通过；未为通过检查放宽进程身份校验。
- 只读 npm 官方 registry：electron 4,299,111 字节、three 941,885 字节、sharp 1,250,806 字节、axios 868,092 字节，均成功；这些包当前均未达到旧上限，不能据此确认报告环境的触发包。额外用 TypeScript 15,865,004 字节、3874 个时间键验证真实超过旧上限的响应通过。

未读取或更新真实 DSH profile，未进行实际插件安装和手机真机验收。没有新 APK，也没有把已有 APK 标记为包含本次修复。

## 改动文件

- `packages/plugin/plugin-center.mjs`：有界流式读取、元数据校验及可定位错误。
- `packages/plugin/plugin-transaction.mjs`：按锁文件规模调整预检预算。
- `public/plugin-center.js`、`packages/plugin/public/plugin-center.js`：预检请求预算。
- `gateway.js`、`packages/plugin/gateway.cjs`：预检代理预算。
- `public/build.json`、`packages/plugin/public/build.json`：同步后的前端指纹。
- `tests/plugin-publication.test.js`、`tests/plugin-transaction.test.js`、`tests/plugin-center-ui.test.js`、`tests/lifecycle.test.js`：读取器、事务、界面和实际网关回归。
- `docs/plugin-center.md`、`docs/issue-28-preflight-and-feedback.md`：使用边界、验证与反馈复核。
