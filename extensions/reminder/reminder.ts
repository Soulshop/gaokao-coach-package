/**
 * 提醒机制控制：渲染 launchd plist 并 bootstrap/bootout。
 *
 * reminder_set 经此把 profile.reminder 状态落到 OS：渲染 .pi/macos/com.gaokao.coach.plist
 * 模板，写入 ~/Library/LaunchAgents/，并 launchctl bootstrap。无需 sudo。
 * 本扩展独立于教学；状态字段 profile.reminder 的 schema 在 ../coach/state.ts。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReminderConfig } from "../coach/state.ts";

export const REMINDER_LABEL = "com.gaokao.coach";
export const REMINDER_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function parseReminderTime(time: string): { hour: number; minute: number } {
  if (!REMINDER_TIME_RE.test(time)) {
    throw new Error(`提醒时间必须是 HH:MM 24h 格式，如 20:00，收到：${time}`);
  }
  return { hour: Number(time.slice(0, 2)), minute: Number(time.slice(3, 5)) };
}

function macosDir(cwd: string): string {
  // 与 state.ts 的 CONFIG_DIR_NAME 一致（".pi"）；硬编码以脱离 pi 运行时依赖，便于单测。
  return join(cwd, ".pi", "macos");
}

function plistTemplatePath(cwd: string): string {
  return join(macosDir(cwd), "com.gaokao.coach.plist");
}

export function remindShPath(cwd: string): string {
  return join(macosDir(cwd), "remind.sh");
}

function launchAgentPath(): string {
  return join(homedir(), "Library/LaunchAgents/com.gaokao.coach.plist");
}

export function renderPlist(cwd: string, config: ReminderConfig): string {
  const templatePath = plistTemplatePath(cwd);
  if (!existsSync(templatePath)) {
    throw new Error(`找不到 plist 模板：${templatePath}。请重跑 scripts/setup.sh 部署 macos 工具链。`);
  }
  const { hour, minute } = parseReminderTime(config.time);
  const template = readFileSync(templatePath, "utf8");
  return template
    .replaceAll("{{REMIND_SH}}", remindShPath(cwd))
    .replaceAll("{{HOUR}}", String(hour))
    .replaceAll("{{MINUTE}}", String(minute));
}

export function isReminderLoaded(): boolean {
  const result = spawnSync("launchctl", ["list"], { encoding: "utf8" });
  if (result.status !== 0) return false;
  return result.stdout.split("\n").some((line) => line.includes(REMINDER_LABEL));
}

function guiTarget(): string {
  return `gui/${process.getuid()}/${REMINDER_LABEL}`;
}

export interface InstallResult {
  loaded: boolean;
}

export function installReminder(cwd: string, config: ReminderConfig): InstallResult {
  const agentPath = launchAgentPath();
  const uid = process.getuid();

  if (!config.enabled) {
    spawnSync("launchctl", ["bootout", guiTarget()], { encoding: "utf8" });
    if (existsSync(agentPath)) rmSync(agentPath, { force: true });
    return { loaded: false };
  }

  const rendered = renderPlist(cwd, config);
  mkdirSync(join(homedir(), "Library/LaunchAgents"), { recursive: true });
  writeFileSync(agentPath, rendered, "utf8");
  // 先 bootout 清旧（忽略未装载），再 bootstrap 装载。load/unload 已废弃且在子进程下静默失败。
  spawnSync("launchctl", ["bootout", guiTarget()], { encoding: "utf8" });
  const boot = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, agentPath], { encoding: "utf8" });
  if (boot.status !== 0) {
    throw new Error(`launchctl bootstrap 失败：${(boot.stderr || boot.stdout).trim() || "未知错误"}`);
  }
  return { loaded: isReminderLoaded() };
}

export interface TestResult {
  fired: boolean;
  output: string;
}

export function testReminder(cwd: string): TestResult {
  const sh = remindShPath(cwd);
  if (!existsSync(sh)) throw new Error(`找不到 remind.sh：${sh}`);
  const result = spawnSync("bash", [sh], { encoding: "utf8" });
  return {
    fired: result.status === 0,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
  };
}
