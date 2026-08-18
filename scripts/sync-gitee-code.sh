#!/usr/bin/env bash
# 同步 GitHub 代码仓库到 Gitee 镜像（镜像语义：force push main + 全部 tag）
set -euo pipefail
: "${GITEE_TOKEN:?需要 GITEE_TOKEN 环境变量}"
GITEE_REMOTE="https://Blankneverfails:${GITEE_TOKEN}@gitee.com/Blankneverfails/dsh-Remote.git"
# token 会出现在 URL 中，但 GitHub Actions 会对 secret 值做日志 masking，安全
git push -f "$GITEE_REMOTE" main
git push -f "$GITEE_REMOTE" --tags
echo "Gitee 代码仓库已同步 (main + tags)"
