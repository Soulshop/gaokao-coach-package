#!/usr/bin/env bash
# 编译 CoachNotifier.app（LSUIElement，无 Dock 图标）。
set -euo pipefail
cd "$(dirname "$0")"

APP="CoachNotifier.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

swiftc -O main.swift \
  -o "$APP/Contents/MacOS/CoachNotifier" \
  -framework AppKit -framework UserNotifications

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.gaokao.coach.notifier</string>
  <key>CFBundleName</key>
  <string>CoachNotifier</string>
  <key>CFBundleExecutable</key>
  <string>CoachNotifier</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

# ad-hoc 签名：UNUserNotificationCenter 要求正规 bundle 签名（绑定 Info.plist
# 与封印 bundle id）。swiftc 默认的 linker-only 签名不绑定 Info.plist，通知授权
# 会以 didGrant=0 hasError=1 失败，故必须显式 codesign。
codesign --force --sign - "$APP"

echo "built: $APP"