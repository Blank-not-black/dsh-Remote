# 安全政策 / Security Policy

## 维护范围

安全修复优先面向最新正式版，并在适用时同步到 `dev`。RC 是候选验证版本；历史版本不承诺持续回补。报告时请给出实际受影响的版本或提交，不要只写 `latest`。

## 报告安全问题

鉴权绕过、目录穿越、未授权文件读写、命令执行和敏感信息泄露等问题应私下报告。请勿在公开 Issue、PR 或 Discussions 中发布利用细节、令牌、Cookie、真实会话或未修复漏洞的完整复现材料。

1. 查看仓库的 [Security → Advisories](https://github.com/Blank-not-black/dsh-Remote/security/advisories)。如果提供 **Report a vulnerability**，使用该入口私下报告。
2. 如果入口不可用，可在 [Issues](https://github.com/Blank-not-black/dsh-Remote/issues) 或 [Discussions](https://github.com/Blank-not-black/dsh-Remote/discussions) 仅告知维护者 [@Blank-not-black](https://github.com/Blank-not-black) 需要安全联系渠道，等待安排私下沟通；不要附上漏洞细节。

私下报告请包含：受影响组件与版本、必要的环境条件、最小复现、预期与实际行为、可能影响，以及已脱敏的证据。仅对自己拥有或获准测试的环境进行验证，避免读取或修改其他用户的数据。

维护者会核查、协调修复并与报告者商定披露时间；本项目不承诺固定响应时限或漏洞奖励。修复公开前请协调披露。普通配置问题和不涉及安全边界的缺陷使用[支持入口](SUPPORT.md)。

Please report vulnerabilities privately using **Report a vulnerability** when available. If unavailable, ask the maintainer for a private contact channel without posting exploit details. Include affected versions, reproduction steps, impact, and redacted evidence.
