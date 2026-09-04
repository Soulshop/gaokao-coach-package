# Mac 提醒链路（通知 → 点击 → 唤起 pi）

原生机制：launchd 定时 → remind.sh 读取到期复习和计划复盘 → Swift 通知横幅 → 点击 → 唤起 Terminal 和 Pi。

## 安装步骤

1. 编译通知小程序（需要 Xcode Command Line Tools）：

   ```bash
   cd notifier && bash build.sh
   ```

   产物：`notifier/CoachNotifier.app`（无 Dock 图标的后台 app）。

2. 给 `remind.sh` 加执行权限：

   ```bash
   chmod +x remind.sh
   ```

3. 改定时时间与路径。编辑 `com.gaokao.coach.plist`：
   - `ProgramArguments` 里 remind.sh 的绝对路径
   - `StartCalendarInterval` 的 Hour/Minute（当前 20:00）

4. 安装 LaunchAgent 并加载：

   ```bash
   cp com.gaokao.coach.plist ~/Library/LaunchAgents/
   launchctl unload ~/Library/LaunchAgents/com.gaokao.coach.plist 2>/dev/null || true
   launchctl load ~/Library/LaunchAgents/com.gaokao.coach.plist
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
3. 待实测项：Swift 通知在 LSUIElement app 下点击回调是否稳定触发；Terminal 弹开后的自动载入会话需要进一步接入 pi 的会话恢复参数。
4. 自动载入「当天教学会话」尚未接线：当前唤起的是新会话，妹妹需手动输入 `/coach` 或输入「开始学习」。后续可用 remind.sh 生成 kickoff 文本或使用 pi 的会话恢复参数补上。

## 日志

- `/tmp/gaokao-coach.log`
- `/tmp/gaokao-coach.err`