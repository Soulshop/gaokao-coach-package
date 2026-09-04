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
# APPEND_SYSTEM（常驻角色）、子代理定义与 macos 工具链属程序。pi 不从包内加载
# APPEND_SYSTEM；pi-subagent 只从工作目录 .pi/agents/ 发现项目代理，不读包内文件。
# 升级后重跑 setup.sh 即把新规则同步到本地。
mkdir -p "$TARGET/.pi"
cp "$PKG_DIR/templates/APPEND_SYSTEM.md" "$TARGET/.pi/APPEND_SYSTEM.md"
echo "更新：.pi/APPEND_SYSTEM.md（随包版本覆盖）"
mkdir -p "$TARGET/.pi/agents"
cp -R "$PKG_DIR/templates/agents/." "$TARGET/.pi/agents/"
echo "部署：.pi/agents/（随包版本覆盖）"
mkdir -p "$TARGET/.pi/macos/notifier"
cp -R "$PKG_DIR/macos/." "$TARGET/.pi/macos/"
echo "部署：.pi/macos/"

# gitignore 属演化件不覆盖，但评分审计日志含学员原话，必须保证被忽略。
# 已存在的消费端 .gitignore 只追加缺失行，不改动已有规则。
if ! grep -qxF ".pi/state/" "$TARGET/.gitignore" 2>/dev/null; then
  # 已有文件末行可能无换行，直接 echo 追加会粘连到末行。
  if [ -s "$TARGET/.gitignore" ] && [ "$(tail -c1 "$TARGET/.gitignore" | wc -l)" -eq 0 ]; then
    printf '\n' >> "$TARGET/.gitignore"
  fi
  echo ".pi/state/" >> "$TARGET/.gitignore"
  echo "追加：.gitignore 忽略 .pi/state/（评分审计日志含学员原话）"
fi

echo "完成。可执行：cd $TARGET && pi"