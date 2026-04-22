#!/usr/bin/env bash
# 从当前项目一键复刻出一个新的分发仓库
# 用法: scripts/new-dist-repo.sh <新仓库名> [站点标题]
# 依赖: gh (已 gh auth login) 、 rsync

set -euo pipefail

REPO_NAME="${1:-}"
SITE_TITLE="${2:-App 分发}"

if [ -z "$REPO_NAME" ]; then
  cat <<EOF
用法: $0 <新仓库名> [站点标题]
示例: $0 customer_abc "ABC 客户分发"

会做的事:
  1. 把当前项目复制到 ../<新仓库名>_project/ (排除 .git / node_modules / 旧产物)
  2. 写入 config.json (repo / publicUrl / siteTitle)
  3. 新建 GitHub 仓库并推送 main
  4. 启用 Pages (main 分支 /docs 目录)
  5. 打开 Actions 写权限
EOF
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "❌ 没装 gh (brew install gh)"; exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "❌ 先运行 gh auth login"; exit 1
fi
if ! command -v rsync >/dev/null 2>&1; then
  echo "❌ 没装 rsync"; exit 1
fi

GH_USER=$(gh api user --jq .login)
TEMPLATE_ROOT=$(cd "$(dirname "$0")/.." && pwd)
PARENT=$(dirname "$TEMPLATE_ROOT")
NEW_DIR="$PARENT/${REPO_NAME}_project"

if [ -e "$NEW_DIR" ]; then
  echo "❌ 目标目录已存在: $NEW_DIR"; exit 1
fi

echo "📋 从模板复制 → $NEW_DIR"
rsync -a \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='docs/apps.json' \
  --exclude='docs/icons/*.png' \
  --exclude='docs/manifest/*.plist' \
  "$TEMPLATE_ROOT/" "$NEW_DIR/"

cd "$NEW_DIR"

echo "📝 写入 config.json"
cat > config.json <<EOF
{
  "repo": "${GH_USER}/${REPO_NAME}",
  "publicUrl": "https://${GH_USER}.github.io/${REPO_NAME}",
  "siteTitle": "${SITE_TITLE}"
}
EOF

echo "🔧 初始化 git"
git init -q
git add -A
git commit -q -m "init from template"
git branch -M main

echo "🚀 创建 GitHub 仓库并推送"
gh repo create "${GH_USER}/${REPO_NAME}" --public --source=. --push

echo "📄 启用 Pages (main 分支 /docs)"
gh api -X POST "repos/${GH_USER}/${REPO_NAME}/pages" \
  -f 'source[branch]=main' \
  -f 'source[path]=/docs' >/dev/null 2>&1 || \
gh api -X PUT "repos/${GH_USER}/${REPO_NAME}/pages" \
  -f 'source[branch]=main' \
  -f 'source[path]=/docs' >/dev/null

echo "🔐 开启 Actions 写权限"
gh api -X PUT "repos/${GH_USER}/${REPO_NAME}/actions/permissions/workflow" \
  -F default_workflow_permissions=write >/dev/null

PAGE_URL="https://${GH_USER}.github.io/${REPO_NAME}/"
cat <<EOF

✅ 搞定!
   新仓库:   https://github.com/${GH_USER}/${REPO_NAME}
   分发页:   ${PAGE_URL}   (Pages 首次部署要等 1-2 分钟)
   本地目录: ${NEW_DIR}

下一步: 去新仓库 Releases 拖个 ipa/apk/dmg/exe 就能看到分发页了
EOF
