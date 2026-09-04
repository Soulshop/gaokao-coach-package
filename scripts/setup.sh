#!/usr/bin/env bash
# 安装引导：把分发包模板复制到学员工作目录。
# 只会创建缺失文件，绝不覆盖已存在的演化数据。
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-$(pwd)}"

if [ ! -d "$TARGET" ]; then
  echo "目标目录不存在：$TARGET"
  echo "用法：scripts/setup.sh <学员工作目录>"
  exit 1
fi

copy_seed() {
  local src="$1" dst="$2"
  if [ -e "$dst" ]; then
    echo "跳过（已存在）：$dst"
  else
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    echo "创建：$dst"
  fi
}

# —— 数据/演化件：首次复制，绝不覆盖 ——
# 知识节点、知识地图、学习计划、gitignore 属学员工作目录演化数据。
# 升级分发包后重跑 setup.sh 不会触碰这些文件。
copy_seed "$PKG_DIR/templates/知识节点.json" "$TARGET/学习资料/知识节点.json"
copy_seed "$PKG_DIR/templates/广东高考知识地图.md" "$TARGET/学习资料/广东高考知识地图.md"
copy_seed "$PKG_DIR/templates/学习计划.md" "$TARGET/学习计划.md"
copy_seed "$PKG_DIR/templates/gitignore" "$TARGET/.gitignore"

# —— 配置件：首次复制，升级时可手动删后重跑以获得新默认值 ——
# settings.json 可能被用户追加自定义 packages，不自动覆盖。
copy_seed "$PKG_DIR/templates/settings.json" "$TARGET/.pi/settings.json"

# —— 规则/工具件：随包更新覆盖 ——
# APPEND_SYSTEM（常驻角色）与 macos 工具链属程序，pi 不从包内加载 APPEND_SYSTEM，
# 升级后重跑 setup.sh 即把新规则同步到本地。
mkdir -p "$TARGET/.pi"
cp "$PKG_DIR/templates/APPEND_SYSTEM.md" "$TARGET/.pi/APPEND_SYSTEM.md"
echo "更新：.pi/APPEND_SYSTEM.md（随包版本覆盖）"
mkdir -p "$TARGET/.pi/macos/notifier"
cp -R "$PKG_DIR/macos/." "$TARGET/.pi/macos/"
echo "部署：.pi/macos/"

echo "完成。可执行：cd $TARGET && pi"