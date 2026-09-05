---
description: 每日学习提醒控制。配置每日提醒时间、装载/卸载 launchd、测试通知。独立于教学。
---

# 提醒控制

每日提醒链路：launchd 到点 → remind.sh 读到期复习 → CoachNotifier 弹通知 → 点击开 Ghostty/Terminal 起 pi。本技能只管「何时弹」与「装不装」，不改教学内容。状态存 `profile.reminder{enabled,time}`。

## 工具

- `reminder_get`：读 enabled、time(HH:MM)、launchd 是否已装载、remind.sh 路径。
- `reminder_set`：设时间(HH:MM 24h) 与启停；写 `profile.reminder` 并渲染 plist + `launchctl bootstrap/bootout`。无需 sudo。
- `reminder_test`：立即跑 remind.sh 弹一条测试通知，不改配置；首次触发系统通知权限框。

## 何时用

- 初始化后（首次或改作息）：问学员「每日几点提醒」（24h HH:MM，默认 20:00），调 `reminder_set {time, enabled:true}` 装载。提示学员在系统弹框允许 CoachNotifier 通知。
- 改时间或暂停/恢复：`reminder_set` 改 time 或 enabled。
- 排查：`reminder_get` 看是否装载；`reminder_test` 验证链路。

时间格式必须 HH:MM 24h（如 20:00、07:15）。`reminder_set` 校验，非法抛错。卸载（enabled:false）会 bootout 并删 `~/Library/LaunchAgents/com.gaokao.coach.plist`。
