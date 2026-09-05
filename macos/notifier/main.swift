// 学习提醒的 Swift 通知小程序。
// 编译成 LSUIElement app（见 build.sh），由 remind.sh 用 open --args 启动。
// 职责：申请通知权限 → 发一条带「开始学习」按钮的原生通知 → 常驻等待点击 → 点击后唤起终端并退出。
import AppKit
import Foundation
import UserNotifications

func arg(_ name: String) -> String? {
  let a = CommandLine.arguments
  guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
  return a[i + 1]
}

let title = arg("--title") ?? "学习提醒"
let body = arg("--body") ?? "该复习啦"
let command = arg("--command") ?? "cd ~/gaokao-coach && pi"

final class Delegate: NSObject, UNUserNotificationCenterDelegate {
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    defer { completionHandler() }
    if response.actionIdentifier == UNNotificationDefaultActionIdentifier
      || response.actionIdentifier == "START"
    {
      runCommand()
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }

  func runCommand() {
    let ghosttyApp = "/Applications/Ghostty.app"
    let userGhostty = NSHomeDirectory() + "/Applications/Ghostty.app"
    let useGhostty = FileManager.default.fileExists(atPath: ghosttyApp)
      || FileManager.default.fileExists(atPath: userGhostty)

    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    if useGhostty {
      // Ghostty 新窗口以登录 shell 跑命令：.zshrc 把 nvm 的 pi 加进 PATH，
      // pi 退出后 exec zsh -il 留住窗口。AppleScript 字符串以双引号定界，
      // 命令内的双引号需转义。
      let escaped = command.replacingOccurrences(of: "\"", with: "\\\"")
      let script = "tell application \"Ghostty\" to new window with configuration {command:\"zsh -lic '\(escaped); exec zsh -il'\"}"
      p.arguments = ["-e", script]
    } else {
      p.arguments = [
        "-e", "tell application \"Terminal\" to activate",
        "-e", "tell application \"Terminal\" to do script \"\(command)\"",
      ]
    }
    try? p.run()
    exit(0)
  }
}

let center = UNUserNotificationCenter.current()
let delegate = Delegate()
center.delegate = delegate

let action = UNNotificationAction(
  identifier: "START", title: "开始学习", options: [.foreground])
let category = UNNotificationCategory(
  identifier: "COACH", actions: [action], intentIdentifiers: [], options: [])
center.setNotificationCategories([category])

center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
  DispatchQueue.main.async {
    guard granted else { exit(0) }

    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.categoryIdentifier = "COACH"
    content.sound = .default

    let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 2, repeats: false)
    let request = UNNotificationRequest(
      identifier: UUID().uuidString, content: content, trigger: trigger)

    center.add(request) { _ in
      // 12 小时未点击自动退出，避免残留进程堆积
      DispatchQueue.main.asyncAfter(deadline: .now() + 12 * 3600) {
        exit(0)
      }
    }
  }
}

RunLoop.main.run()