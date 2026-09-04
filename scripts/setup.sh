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

# 模板种子 → 工作目录
copy_seed "$PKG_DIR/templates/APPEND_SYSTEM.md" "$TARGET/.pi/APPEND_SYSTEM.md"
copy_seed "$PKG_DIR/templates/settings.json" "$TARGET/.pi/settings.json"
copy_seed "$PKG_DIR/templates/知识节点.json" "$TARGET/学习资料/知识节点.json"
copy_seed "$PKG_DIR/templates/广东高考知识地图.md" "$TARGET/学习资料/广东高考知识地图.md"
copy_seed "$PKG_DIR/templates/学习计划.md" "$TARGET/学习计划.md"
copy_seed "$PKG_DIR/templates/gitignore" "$TARGET/.gitignore"

# macos 工具链：部署件，允许覆盖
mkdir -p "$TARGET/.pi/macos/notifier"
cp -R "$PKG_DIR/macos/." "$TARGET/.pi/macos/"
echo "部署：.pi/macos/"

echo "完成。可执行：cd $TARGET && pi"