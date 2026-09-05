# Mac 提醒链路（通知 → 点击 → 唤起 pi）

原生机制：launchd 定时 → remind.sh 读取到期复习和计划复盘 → Swift 通知横幅 → 点击 → 唤起 Terminal 和 Pi。

## 安装步骤

1. 通知小程序已预构建并 ad-hoc 签名，随 `setup.sh` 部署到 `notifier/CoachNotifier.app`（无 Dock 图标的后台 app）。首次通知会申请系统通知权限，在学员 Mac 上允许 CoachNotifier。

   仅当修改 `notifier/main.swift` 后才需重新编译（需要 Xcode Command Line Tools），`build.sh` 会自动签名：

   ```bash
   cd notifier && bash build.sh
   ```

2. 给 `remind.sh` 加执行权限：

   ```bash
   chmod +x remind.sh
   ```

3. 定时由教员控制，无需手动编辑。`com.gaokao.coach.plist` 是带 token 的模板（`{{REMIND_SH}}`/`{{HOUR}}`/`{{MINUTE}}`）：`coach_complete_init` 渲染并 `launchctl bootstrap` 装载到 `~/Library/LaunchAgents/`，每日到点弹通知。改时间或启停用 `coach_set_reminder`，查状态用 `coach_get_reminder`，立即弹一条测试用 `coach_test_reminder`。

4. 手动备用（不推荐，仅在脱离教员时）：替换 token 后 `launchctl bootstrap`：

   ```bash
   # 替换 {{REMIND_SH}} 为本目录 remind.sh 绝对路径、{{HOUR}}/{{MINUTE}} 为时间
   cp com.gaokao.coach.plist ~/Library/LaunchAgents/
   launchctl bootout gui/$(id -u)/com.gaokao.coach 2>/dev/null || true
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gaokao.coach.plist
   ```

5. 通知权限：首次通知会在系统设置里申请「通知」权限，需在妹妹的 Mac 上允许 CoachNotifier。

## 手动测试

```bash
bash remind.sh
```

正常会弹横幅，右上角出现「开始学习」按钮，点击后打开终端并 `cd ~/gaokao-coach && pi`。

## 已知边界与待验证

1. 通知的点击回调归「发通知的 app」所有，故小程序发出通知后常驻等待，12 小时未点击自动退出。这段时间内它留在后台，无 Dock 图标。
2. 发送通知前用 `pkill -f CoachNotifier` 清残留实例，避免每天堆积。
3. 已实测：LSUIElement app 下点击横幅稳定触发回调并打开终端（装了 Ghostty 则用 Ghostty，否则 Terminal）启动 pi。自动载入「当天教学会话」尚未接线（见下条）。
4. 自动载入「当天教学会话」尚未接线：当前唤起的是新会话，妹妹需手动输入 `/coach` 或输入「开始学习」。后续可用 remind.sh 生成 kickoff 文本或使用 pi 的会话恢复参数补上。

## 日志

- `/tmp/gaokao-coach.log`
- `/tmp/gaokao-coach.err`