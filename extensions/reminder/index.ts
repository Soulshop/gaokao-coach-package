/**
 * 提醒控制扩展：每日提醒时间与启停，渲染 launchd plist 并 bootstrap/bootout。
 * 独立于教学；读写 profile.reminder 状态字段，OS 操作无需 sudo。
 */
import {
  defineTool,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  loadProfile,
  profilePath,
  saveProfile,
  type Profile,
} from "../coach/state.ts";
import {
  installReminder,
  isReminderLoaded,
  remindShPath,
  REMINDER_TIME_RE,
  testReminder,
} from "./reminder.ts";

function boundedJson(value: unknown): string {
  return JSON.stringify(value);
}

async function mutateReminder(ctx: ExtensionContext, fn: (profile: Profile) => void): Promise<Profile> {
  return withFileMutationQueue(profilePath(ctx.cwd), async () => {
    const profile = loadProfile(ctx.cwd);
    fn(profile);
    saveProfile(ctx.cwd, profile);
    return profile;
  });
}

const getReminderTool = defineTool({
  name: "reminder_get",
  label: "Reminder: Get",
  description:
    "读取每日提醒配置与 launchd 装载状态。返回 enabled、time(HH:MM)、loaded、remindShPath。",
  parameters: Type.Object({}),
  async execute(_callId, _params, _signal, _onUpdate, ctx) {
    const profile = loadProfile(ctx.cwd);
    const summary = {
      enabled: profile.reminder.enabled,
      time: profile.reminder.time,
      loaded: isReminderLoaded(),
      remindShPath: remindShPath(ctx.cwd),
    };
    return { content: [{ type: "text", text: boundedJson(summary) }], details: summary };
  },
});

const setReminderTool = defineTool({
  name: "reminder_set",
  label: "Reminder: Set",
  description:
    "设置每日提醒时间(HH:MM 24h)与启停，写入 profile.reminder 并渲染 plist + launchctl bootstrap/bootout。无需 sudo。改时间或启用/禁用都用它。",
  parameters: Type.Object({
    time: Type.Optional(Type.String({ description: "提醒时间 HH:MM 24h，如 20:00" })),
    enabled: Type.Optional(Type.Boolean({ description: "是否启用并装载 launchd" })),
  }),
  async execute(_callId, params, _signal, _onUpdate, ctx) {
    const profile = await mutateReminder(ctx, (profile) => {
      if (typeof params.time === "string") {
        const t = params.time.trim();
        if (!REMINDER_TIME_RE.test(t)) throw new Error("提醒时间必须是 HH:MM 24h 格式，如 20:00");
        profile.reminder.time = t;
      }
      if (typeof params.enabled === "boolean") profile.reminder.enabled = params.enabled;
    });
    const result = installReminder(ctx.cwd, profile.reminder);
    return {
      content: [
        {
          type: "text",
          text: `提醒已更新：时间 ${profile.reminder.time}，启用 ${profile.reminder.enabled}，launchd ${result.loaded ? "已装载" : "未装载"}。`,
        },
      ],
      details: { reminder: profile.reminder, loaded: result.loaded },
    };
  },
});

const testReminderTool = defineTool({
  name: "reminder_test",
  label: "Reminder: Test",
  description:
    "立即跑 remind.sh 弹一条提醒通知做 smoke test，不改 launchd 与提醒配置。首次会触发系统通知权限框。",
  parameters: Type.Object({}),
  async execute(_callId, _params, _signal, _onUpdate, ctx) {
    const result = testReminder(ctx.cwd);
    return {
      content: [
        {
          type: "text",
          text: result.fired
            ? `已触发 remind.sh。${result.output ? `输出：${result.output}` : "通知应在数秒内弹出。"}`
            : `remind.sh 执行失败：${result.output}`,
        },
      ],
      details: result,
    };
  },
});

export default function reminderExtension(pi: ExtensionAPI): void {
  pi.registerTool(getReminderTool);
  pi.registerTool(setReminderTool);
  pi.registerTool(testReminderTool);
}
