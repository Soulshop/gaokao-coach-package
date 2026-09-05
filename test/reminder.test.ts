import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseReminderTime, renderPlist, REMINDER_TIME_RE } from "../extensions/coach/reminder.ts";

test("parseReminderTime 合法 HH:MM", () => {
  assert.deepEqual(parseReminderTime("20:30"), { hour: 20, minute: 30 });
  assert.deepEqual(parseReminderTime("09:05"), { hour: 9, minute: 5 });
  assert.deepEqual(parseReminderTime("00:00"), { hour: 0, minute: 0 });
  assert.deepEqual(parseReminderTime("23:59"), { hour: 23, minute: 59 });
});

test("REMINDER_TIME_RE 拒绝非法时间", () => {
  for (const bad of ["9:05", "24:00", "20:60", "20-30", "abc", "20:3", "200:30", ""]) {
    assert.equal(REMINDER_TIME_RE.test(bad), false, `应拒绝：${bad}`);
  }
});

test("parseReminderTime 非法格式抛错", () => {
  assert.throws(() => parseReminderTime("24:00"));
  assert.throws(() => parseReminderTime("abc"));
  assert.throws(() => parseReminderTime("20:60"));
});

test("renderPlist 替换 token 且无残留", () => {
  const dir = mkdtempSync(join(tmpdir(), "reminder-"));
  const macosDir = join(dir, ".pi", "macos");
  mkdirSync(macosDir, { recursive: true });
  writeFileSync(
    join(macosDir, "com.gaokao.coach.plist"),
    [
      `<?xml version="1.0"?>`,
      `<plist version="1.0"><dict>`,
      `  <key>ProgramArguments</key><array><string>/bin/bash</string><string>{{REMIND_SH}}</string></array>`,
      `  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>{{HOUR}}</integer><key>Minute</key><integer>{{MINUTE}}</integer></dict>`,
      `</dict></plist>`,
      ``,
    ].join("\n"),
  );
  const rendered = renderPlist(dir, { enabled: true, time: "07:15" });
  assert.ok(rendered.includes(join(dir, ".pi", "macos", "remind.sh")), "替换 REMIND_SH 为工作目录 remind.sh 路径");
  assert.ok(rendered.includes("<integer>7</integer>"), "替换 HOUR");
  assert.ok(rendered.includes("<integer>15</integer>"), "替换 MINUTE");
  assert.ok(!rendered.includes("{{"), "无残留 token");
  rmSync(dir, { recursive: true, force: true });
});

test("renderPlist 模板缺失抛错", () => {
  const dir = mkdtempSync(join(tmpdir(), "reminder-empty-"));
  assert.throws(() => renderPlist(dir, { enabled: true, time: "20:00" }), /plist 模板/);
  rmSync(dir, { recursive: true, force: true });
});
