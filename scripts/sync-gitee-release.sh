#!/usr/bin/env bash
# 同步 GitHub Release 到 Gitee 镜像仓库（创建 Release + 上传全部资产）
# 用法: GITEE_TOKEN=xxx RELEASE_TAG=v0.x.x bash scripts/sync-gitee-release.sh
# 依赖: gh CLI (下载 GitHub 资产) + python3 (Gitee API 交互)
set -euo pipefail

: "${GITEE_TOKEN:?需要 GITEE_TOKEN 环境变量}"
: "${RELEASE_TAG:?需要 RELEASE_TAG 环境变量}"

GITEE_OWNER="Blankneverfails"
GITEE_REPO="dsh-Remote"
API="https://gitee.com/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}"

echo "==> 1/4 从 GitHub 获取 release 信息: ${RELEASE_TAG}"
gh release view "$RELEASE_TAG" \
  --json tagName,name,body --jq '{tagName, name, body}' > /tmp/gitee_release_info.json
cat /tmp/gitee_release_info.json

echo "==> 2/4 下载 GitHub release 资产"
rm -rf /tmp/gitee_assets && mkdir -p /tmp/gitee_assets
gh release download "$RELEASE_TAG" --dir /tmp/gitee_assets
ls -la /tmp/gitee_assets

echo "==> 3/4 创建 Gitee release（先删旧的保证幂等）"
# Gitee 删除 API 按 release 数字 id（不是 tag 名）：先查列表找 id
RID=$(curl -s -H "Authorization: token ${GITEE_TOKEN}" \
  "${API}/releases?per_page=100" \
  | python3 -c "
import sys, json
try:
    rels = json.load(sys.stdin)
except Exception:
    rels = []
for r in rels:
    if r.get('tag_name') == '${RELEASE_TAG}':
        print(r.get('id', ''))
        break
")
if [ -n "$RID" ]; then
  curl -s -X DELETE "${API}/releases/${RID}" -H "Authorization: token ${GITEE_TOKEN}" || true
  echo "已删除旧 release id=${RID}"
else
  echo "无旧 release，跳过删除"
fi

RID=$(python3 - "$RELEASE_TAG" <<'PYEOF'
import json, os, sys, urllib.request, urllib.parse, urllib.error

tag = sys.argv[1]
token = os.environ['GITEE_TOKEN']
info = json.load(open('/tmp/gitee_release_info.json'))
body = (info.get('body') or '')[:5000]

params = urllib.parse.urlencode({
    'access_token': token,
    'tag_name': tag,
    'name': info.get('name') or tag,
    'body': body,
    'target_commitish': 'main',
    'prerelease': False,
})
req = urllib.request.Request(
    f"https://gitee.com/api/v5/repos/Blankneverfails/dsh-Remote/releases?{params}",
    method='POST')
try:
    resp = urllib.request.urlopen(req, timeout=30)
    out = json.loads(resp.read().decode())
    print(out.get('id'))
except urllib.error.HTTPError as e:
    print(f"创建失败 HTTP {e.code}: {e.read().decode()[:400]}", file=sys.stderr)
    sys.exit(1)
PYEOF
)
echo "Gitee release id: ${RID}"

echo "==> 4/4 上传资产到 Gitee release"
for file in /tmp/gitee_assets/*; do
  [ -f "$file" ] || continue
  fname=$(basename "$file")
  echo "  upload ${fname}..."
  http_code=$(curl -s -o /tmp/gitee_upload_resp.json -w '%{http_code}' -X POST \
    "${API}/releases/${RID}/attach_files" \
    -H "Authorization: token ${GITEE_TOKEN}" \
    -F "name=${fname}" \
    -F "file=@${file}")
  echo "    HTTP ${http_code}: $(head -c 200 /tmp/gitee_upload_resp.json)"
done

echo "==> 完成。查看: https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}/releases"