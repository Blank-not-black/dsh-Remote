#!/usr/bin/env bash
# 同步 GitHub 代码仓库到 Gitee 镜像（镜像语义：force push main + 全部 tag）
set -euo pipefail
: "${GITEE_TOKEN:?需要 GITEE_TOKEN 环境变量}"
GITEE_REMOTE="https://gitee.com/Blankneverfails/dsh-Remote.git"

# 本地直传时不能依赖 GitHub Actions 的 secret masking，也不要把 token 放进
# URL/argv。用短命 askpass 脚本从环境变量读取，退出时立即删除。
ASKPASS_FILE=$(mktemp)
cleanup() { rm -f "$ASKPASS_FILE"; }
trap cleanup EXIT
chmod 700 "$ASKPASS_FILE"
printf '%s\n' \
  '#!/usr/bin/env sh' \
  'case "$1" in' \
  '  *Username*) printf "%s\\n" "Blankneverfails" ;;' \
  '  *) printf "%s\\n" "$GITEE_TOKEN" ;;' \
  'esac' > "$ASKPASS_FILE"

GIT_ASKPASS="$ASKPASS_FILE" GIT_TERMINAL_PROMPT=0 GIT_HTTP_LOW_SPEED_LIMIT=1 GIT_HTTP_LOW_SPEED_TIME=60 \
  timeout 600s git push -f "$GITEE_REMOTE" main
GIT_ASKPASS="$ASKPASS_FILE" GIT_TERMINAL_PROMPT=0 GIT_HTTP_LOW_SPEED_LIMIT=1 GIT_HTTP_LOW_SPEED_TIME=60 \
  timeout 600s git push -f "$GITEE_REMOTE" --tags
echo "Gitee 代码仓库已同步 (main + tags)"
