import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addDays } from "./scheduler.ts";
import type { Milestone, PlanFocus, StudyPlan } from "./state.ts";

export const PLAN_REVIEW_DAYS = 7;
export const PLAN_CYCLE_DAYS = 14;

export interface InitialPlanInput {
  longTermGoal: string;
  currentFocus: PlanFocus[];
  milestoneTitle: string;
  milestoneKnowledgeIds: string[];
  milestoneSuccessCriteria: string[];
  milestoneTargetDate?: string;
  subjectReviewNotes: Record<string, string>;
}

export interface PlanReviewInput {
  longTermGoal?: string;
  currentFocus: PlanFocus[];
  milestoneUpdates: Array<{
    id: string;
    status: "active" | "done" | "paused";
    targetDate?: string;
    successCriteria?: string[];
    note?: string;
  }>;
  newMilestones: Array<{
    title: string;
    knowledgeIds: string[];
    successCriteria: string[];
    targetDate: string;
  }>;
  subjectReviews: Array<{ subject: string; note: string }>;
  reflection: string;
}

function requireDate(iso: string | undefined, field: string): string {
  if (!iso) throw new Error(`无法计算 ${field}`);
  return iso;
}

function milestoneId(now: string, index: number): string {
  return `milestone-${Date.parse(now)}-${index}`;
}

export function createInitialPlan(input: InitialPlanInput, now: string): StudyPlan {
  const cycleEnd = requireDate(addDays(now, PLAN_CYCLE_DAYS), "两周周期结束时间");
  const nextReviewAt = requireDate(addDays(now, PLAN_REVIEW_DAYS), "每周复盘时间");
  const milestoneTargetDate = input.milestoneTargetDate
    ? new Date(input.milestoneTargetDate).toISOString()
    : cycleEnd;
  if (new Date(milestoneTargetDate) > new Date(cycleEnd)) {
    throw new Error("首个里程碑目标日期不能超过两周周期");
  }

  return {
    revision: 1,
    createdAt: now,
    updatedAt: now,
    cycleStart: now,
    cycleEnd,
    longTermGoal: input.longTermGoal.trim(),
    currentFocus: input.currentFocus.map((focus) => ({
      knowledgeId: focus.knowledgeId,
      reason: focus.reason.trim(),
    })),
    milestones: [
      {
        id: milestoneId(now, 0),
        title: input.milestoneTitle.trim(),
        knowledgeIds: [...new Set(input.milestoneKnowledgeIds)],
        successCriteria: input.milestoneSuccessCriteria.map((item) => item.trim()),
        targetDate: milestoneTargetDate,
        status: "active",
      },
    ],
    subjectReviews: Object.fromEntries(
      Object.entries(input.subjectReviewNotes).map(([subject, note]) => [
        subject,
        { subject, note: note.trim(), lastReviewedAt: now, nextReviewAt },
      ]),
    ),
    dailyRoutine: [
      "先完成按计划选出的到期复习",
      "只推进一个当前主攻知识节点",
      "完成一次理由验证和一次近迁移",
      "记录本次结果、主观状态和下次起点",
    ],
    reviewCadenceDays: PLAN_REVIEW_DAYS,
    nextReviewAt,
  };
}

export function reviewPlan(plan: StudyPlan, input: PlanReviewInput, now: string): StudyPlan {
  const next = structuredClone(plan);
  const updates = new Map(input.milestoneUpdates.map((item) => [item.id, item]));

  for (const milestone of next.milestones) {
    const update = updates.get(milestone.id);
    if (!update) continue;
    milestone.status = update.status;
    milestone.note = update.note?.trim() || undefined;
    milestone.completedAt = update.status === "done" ? now : undefined;
    if (update.targetDate) milestone.targetDate = new Date(update.targetDate).toISOString();
    if (update.successCriteria) {
      milestone.successCriteria = update.successCriteria.map((criterion) => criterion.trim());
    }
  }

  const newItems: Milestone[] = input.newMilestones.map((item, index) => ({
    id: milestoneId(now, next.milestones.length + index),
    title: item.title.trim(),
    knowledgeIds: [...new Set(item.knowledgeIds)],
    successCriteria: item.successCriteria.map((criterion) => criterion.trim()),
    targetDate: new Date(item.targetDate).toISOString(),
    status: "active",
  }));

  next.milestones.push(...newItems);
  next.subjectReviews = Object.fromEntries(
    input.subjectReviews.map((item) => [
      item.subject,
      {
        subject: item.subject,
        note: item.note.trim(),
        lastReviewedAt: now,
        nextReviewAt: requireDate(addDays(now, next.reviewCadenceDays), "科目复盘时间"),
      },
    ]),
  );
  next.longTermGoal = input.longTermGoal?.trim() || next.longTermGoal;
  next.currentFocus = input.currentFocus.map((focus) => ({
    knowledgeId: focus.knowledgeId,
    reason: focus.reason.trim(),
  }));
  next.revision += 1;
  next.updatedAt = now;
  next.cycleStart = now;
  next.cycleEnd = requireDate(addDays(now, PLAN_CYCLE_DAYS), "两周周期结束时间");
  next.lastReviewedAt = now;
  next.nextReviewAt = requireDate(addDays(now, next.reviewCadenceDays), "下次复盘时间");
  next.lastReflection = input.reflection.trim();
  return next;
}

function dateOnly(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : "未设置";
}

function statusText(status: Milestone["status"]): string {
  if (status === "done") return "已完成";
  if (status === "paused") return "已暂停";
  return "进行中";
}

export function renderStudyPlan(plan: StudyPlan, dailyMinutes: number, preferredTime: string): string {
  const focus = plan.currentFocus.length
    ? plan.currentFocus.map((item) => `- \`${item.knowledgeId}\`：${item.reason}`).join("\n")
    : "- 当前没有主攻节点。下次复盘必须补齐。";

  const milestones = plan.milestones.length
    ? plan.milestones
        .map(
          (item) =>
            `| ${item.title} | ${item.knowledgeIds.map((id) => `\`${id}\``).join("<br>")} | ${item.successCriteria.join("<br>")} | ${dateOnly(item.targetDate)} | ${statusText(item.status)} |`,
        )
        .join("\n")
    : "| 暂无 | — | — | — | — |";

  const routine = plan.dailyRoutine.map((item, index) => `${index + 1}. ${item}`).join("\n");
  const subjectReviews = Object.values(plan.subjectReviews ?? {})
    .map((item) => `| ${item.subject} | ${item.note} | ${dateOnly(item.nextReviewAt)} |`)
    .join("\n");
  const reflection = plan.lastReflection || "尚未进行首次周复盘。";

  return `# 学习计划

> 本文件由 coach 扩展根据 \`.pi/state/profile.json\` 生成。不要手工维护两份计划。

## 长期目标

${plan.longTermGoal}

## 当前两周周期

- 开始：${dateOnly(plan.cycleStart)}
- 结束：${dateOnly(plan.cycleEnd)}
- 计划版本：${plan.revision}

## 当前主攻

${focus}

## 阶段里程碑

| 里程碑 | 知识节点 | 可观察通过标准 | 目标日期 | 状态 |
| --- | --- | --- | --- | --- |
${milestones}

## 六科复盘

| 科目 | 当前结论 | 下次检查 |
| --- | --- | --- |
${subjectReviews}

## 每日安排

- 每天总时长：${dailyMinutes} 分钟
- 偏好时段：${preferredTime}

${routine}

## 复盘

- 复盘周期：每 ${plan.reviewCadenceDays} 天
- 下次复盘：${dateOnly(plan.nextReviewAt)}
- 最近复盘：${dateOnly(plan.lastReviewedAt)}
- 最近结论：${reflection}
`;
}

export function learningPlanPath(cwd: string): string {
  return join(cwd, "学习计划.md");
}

export function writeStudyPlan(cwd: string, plan: StudyPlan, dailyMinutes: number, preferredTime: string): void {
  const target = learningPlanPath(cwd);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, renderStudyPlan(plan, dailyMinutes, preferredTime), "utf8");
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}
