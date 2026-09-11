/**
 * 广东高考学习教员扩展。
 *
 * 教学规则在 SKILL.md。本扩展强制保存状态、不变量、计划和间隔复习结果。
 */
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  canonicalKnowledgeId,
  loadCatalog,
  requireKnowledge,
  type KnowledgeCatalog,
} from "./catalog.ts";
import {
  PLAN_CYCLE_DAYS,
  createInitialPlan,
  learningPlanPath,
  reviewPlan,
  writeStudyPlan,
  type PlanReviewInput,
} from "./plan.ts";
import { addDays, isDue, nowIso, sm2 } from "./scheduler.ts";
import {
  appendAuditRecord,
  auditStats,
  differingDimensions,
  gradingAuditPath,
  missingArbitrations,
  readAuditLog,
  REVIEW_AUDIT_DIMENSIONS,
  TURN_AUDIT_DIMENSIONS,
  type AuditArbitration,
  type AuditKind,
  type AuditRecord,
  type ReviewAuditLabels,
  type TurnAuditLabels,
} from "./audit.ts";
import {
  DEFAULT_PROFILE,
  REQUIRED_SPACED_PASSES,
  createKnowledgeNode,
  loadProfile,
  profilePath,
  saveProfile,
  type ActiveTask,
  type AttemptDepth,
  type BaselineSource,
  type EvidenceKind,
  type ExplanationGate,
  type GuidanceMethod,
  type OverviewItem,
  type PlanFocus,
  type Profile,
  type QuestionRole,
  type SessionMode,
  type VerificationStep,
} from "./state.ts";
import {
  allVerificationPassed,
  applyTurn,
  canFinishLocally,
  computeExplanationEligibility,
  computeOverview,
  computeReadiness,
  createActiveTask,
  createExplanation,
  recordVerificationStatus,
  resetTaskForResume,
  reviewQuality,
  verificationRemediation,
  type TurnInput,
} from "./teaching.ts";

const FIRST_ELECTIVES = ["物理", "历史"] as const;
const SECOND_ELECTIVES = ["化学", "生物", "政治", "地理"] as const;
const BASELINE_SOURCES = ["self-report", "school-result", "diagnostic"] as const;
const TASK_MODES = ["teach", "review"] as const;
const ATTEMPT_DEPTHS = ["none", "recognition", "generative"] as const;
const PROGRESS_STATES = ["new", "none"] as const;
const QUESTION_ROLES = [
  "core",
  "key-subproblem",
  "connection",
  "prerequisite-diagnostic",
  "verification",
] as const;
const GUIDANCE_METHODS = [
  "none",
  "locate",
  "smaller-question",
  "split",
  "precision",
  "structural-example",
  "analogy",
  "contrast",
  "learner-example",
  "reconstruct",
  "limited-choice",
  "context-comparison",
] as const;
const EVIDENCE_KINDS = [
  "define",
  "boundary",
  "distinguish",
  "relate",
  "reason",
  "apply",
  "example",
  "counterexample",
  "self-correct",
  "near-transfer",
  "purpose",
  "derive",
  "reconstruct",
  "error",
] as const;
const AUDIT_DIMENSIONS = [...new Set([...TURN_AUDIT_DIMENSIONS, ...REVIEW_AUDIT_DIMENSIONS])] as string[];
const ARBITRATION_DECISIONS = ["coach", "auditor"] as const;
const OVERVIEW_ITEMS = ["goal", "known", "missing", "concept", "relation"] as const;
const VERIFICATION_STEPS = ["restate", "reason", "near-transfer", "counterexample", "return"] as const;
const EXPLANATION_GATES = ["A", "B", "C", "prerequisite"] as const;
const TRANSITION_ACTIONS = [
  "authorize-explanation",
  "block-for-prerequisite",
  "finish-verified",
  "pause",
  "discard-paused",
] as const;
const PAUSE_REASONS = ["emotion", "manual"] as const;
const SESSION_MODES = ["init", "teach", "review", "prep", "plan-review"] as const;
const PLAN_REASONS = ["weekly", "exam", "manual", "initial-repair"] as const;
const MILESTONE_STATUSES = ["active", "done", "paused"] as const;

function canonicalizeProfile(profile: Profile, catalog: KnowledgeCatalog): void {
  for (const [oldId, canonicalId] of Object.entries(catalog.aliases)) {
    const oldNode = profile.knowledge[oldId];
    if (oldNode) {
      const canonicalNode = profile.knowledge[canonicalId];
      if (canonicalNode) {
        canonicalNode.evidence.push(...oldNode.evidence);
        canonicalNode.reviewHistory.push(...oldNode.reviewHistory);
        canonicalNode.attempts += oldNode.attempts;
        canonicalNode.reviews += oldNode.reviews;
        canonicalNode.spacedPasses = Math.max(canonicalNode.spacedPasses, oldNode.spacedPasses);
        canonicalNode.localVerifiedAt ??= oldNode.localVerifiedAt;
        canonicalNode.localVerification ??= oldNode.localVerification;
        canonicalNode.lastPractice ??= oldNode.lastPractice;
        canonicalNode.lastReview ??= oldNode.lastReview;
        canonicalNode.nextReview ??= oldNode.nextReview;
        canonicalNode.evidence.sort((left, right) => left.date.localeCompare(right.date));
        canonicalNode.reviewHistory.sort((left, right) => left.date.localeCompare(right.date));
        const stateRank: Record<string, number> = { new: 0, learning: 1, review: 2, mastered: 3, blocked: 4 };
        if (stateRank[oldNode.state] > (stateRank[canonicalNode.state] ?? 0)) {
          canonicalNode.state = oldNode.state;
        }
        if (canonicalNode.localVerification && canonicalNode.state === "new") {
          canonicalNode.state = "review";
        }
      } else {
        oldNode.id = canonicalId;
        profile.knowledge[canonicalId] = oldNode;
      }
      delete profile.knowledge[oldId];
    }
  }

  const canonicalize = (id: string | undefined) => (id ? canonicalKnowledgeId(catalog, id) : id);
  if (profile.plan) {
    profile.plan.subjectReviews ??= Object.fromEntries(
      profile.learner.subjects.map((subject) => [
        subject,
        {
          subject,
          note: "旧计划待首次六科复盘",
          lastReviewedAt: profile.plan!.createdAt,
          nextReviewAt: profile.plan!.nextReviewAt,
        },
      ]),
    );
    profile.plan.currentFocus.forEach((item) => {
      item.knowledgeId = canonicalize(item.knowledgeId)!;
    });
    profile.plan.milestones.forEach((item) => {
      item.knowledgeIds = [...new Set(item.knowledgeIds.map((id) => canonicalize(id)!))];
    });
  }
  const tasks = [
    profile.teaching.activeTask,
    ...profile.teaching.pausedTasks,
    ...profile.teaching.completedTasks,
  ].filter((task): task is ActiveTask => task !== null);
  for (const task of tasks) {
    task.knowledgeId = canonicalize(task.knowledgeId)!;
    task.blockedBy = canonicalize(task.blockedBy);
    for (const turn of task.turns) {
      turn.candidatePrerequisiteId = canonicalize(turn.candidatePrerequisiteId);
    }
  }
  for (const node of Object.values(profile.knowledge)) {
    node.blockedBy = canonicalize(node.blockedBy);
    const definition = catalog.nodes.find((item) => item.id === node.id);
    node.catalogMissing = !definition;
    if (definition) {
      node.id = definition.id;
      node.subject = definition.subject;
      node.name = definition.name;
    }
  }
}

function readState(ctx: ExtensionContext): Profile {
  const profile = loadProfile(ctx.cwd);
  canonicalizeProfile(profile, loadCatalog(ctx.cwd));
  return profile;
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function requireNonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} 不能为空白`);
  return trimmed;
}

function activeTaskOrThrow(profile: Profile, taskId: string): ActiveTask {
  const task = profile.teaching.activeTask;
  if (!task) throw new Error("当前没有活动教学任务。先调用 coach_start_task。");
  if (task.id !== taskId) throw new Error(`任务已变化。当前 taskId 是 ${task.id}`);
  return task;
}

function archiveTask(profile: Profile, task: ActiveTask, now: string): void {
  task.phase = "completed";
  task.updatedAt = now;
  profile.teaching.completedTasks.push(task);
  if (profile.teaching.completedTasks.length > 100) {
    profile.teaching.completedTasks.splice(0, profile.teaching.completedTasks.length - 100);
  }
}

function recentEmotionalSignals(profile: Profile): number {
  const turns = [
    ...(profile.teaching.activeTask?.turns ?? []),
    ...profile.teaching.pausedTasks.flatMap((task) => task.turns),
    ...profile.teaching.completedTasks.slice(-5).flatMap((task) => task.turns),
  ];
  return turns.slice(-10).filter((turn) => turn.emotionalSignal).length;
}

function ensureInitialized(profile: Profile): void {
  if (!profile.initialized) throw new Error("未初始化。只能继续初始化引导。");
}

function getOrCreateKnowledge(profile: Profile, catalog: KnowledgeCatalog, id: string) {
  const definition = requireKnowledge(catalog, id);
  const canonicalId = definition.id;
  const node =
    profile.knowledge[canonicalId] ?? createKnowledgeNode(canonicalId, definition.subject, definition.name);
  node.catalogMissing = false;
  profile.knowledge[canonicalId] = node;
  return { definition, node, canonicalId };
}

async function mutateProfile<T>(
  ctx: ExtensionContext,
  mutate: (profile: Profile) => T | Promise<T>,
  syncPlan = false,
): Promise<{ profile: Profile; value: T }> {
  const result = await withFileMutationQueue(profilePath(ctx.cwd), async () => {
    const profile = loadProfile(ctx.cwd);
    canonicalizeProfile(profile, loadCatalog(ctx.cwd));
    const value = await mutate(profile);
    saveProfile(ctx.cwd, profile);

    if (syncPlan && profile.plan) {
      await withFileMutationQueue(learningPlanPath(ctx.cwd), async () => {
        const minutes = profile.learner.schedule.dailyMinutes;
        const time = profile.learner.schedule.preferredTime;
        if (minutes === null || time === null) throw new Error("计划缺少每天时长或偏好时段");
        writeStudyPlan(ctx.cwd, profile.plan!, minutes, time);
      });
    }
    return { profile, value };
  });
  refreshWidget(ctx, result.profile);
  return result;
}

function recentFeelingPolicy(profile: Profile) {
  const feelings = profile.sessions
    .map((session) => session.feeling)
    .filter((value): value is number => value !== undefined)
    .slice(-3);
  const lowCount = feelings.filter((value) => value <= 2).length;
  return {
    recentReportedFeelings: feelings,
    protectedPacing: feelings.length >= 2 && lowCount >= 2,
    rule:
      feelings.length >= 2 && lowCount >= 2
        ? "本次只设一个主目标。先做一个可验证的旧知识任务。减少新内容数量。"
        : "按学习计划安排节奏。",
  };
}

function planReviewDue(profile: Profile, now = new Date()): boolean {
  return Boolean(profile.plan?.nextReviewAt && new Date(profile.plan.nextReviewAt) <= now);
}

function dueNodes(profile: Profile, now = new Date()) {
  const focusIds = new Set(profile.plan?.currentFocus.map((item) => item.knowledgeId) ?? []);
  return Object.values(profile.knowledge)
    .filter((node) => !node.catalogMissing && isDue(node.nextReview, now))
    .sort((left, right) => {
      const focusDelta = Number(focusIds.has(right.id)) - Number(focusIds.has(left.id));
      if (focusDelta !== 0) return focusDelta;
      return String(left.nextReview).localeCompare(String(right.nextReview));
    });
}

function boundedJson(value: unknown, fullPath?: string): string {
  const json = JSON.stringify(value, null, 2);
  const result = truncateHead(json, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!result.truncated) return result.content;
  return `${result.content}\n\n[输出已截断。完整状态文件：${fullPath ?? ".pi/state/profile.json"}]`;
}

function taskSummary(task: ActiveTask | null) {
  if (!task) return null;
  return {
    id: task.id,
    knowledgeId: task.knowledgeId,
    mode: task.mode,
    phase: task.phase,
    supportDepth: task.supportDepth,
    methodsUsed: task.methodsUsed,
    rounds: task.rounds,
    meaningfulRounds: task.meaningfulRounds,
    effectiveAttempts: task.effectiveAttempts,
    microProgress: task.microProgress,
    noProgressStreak: task.noProgressStreak,
    refusalStreak: task.refusalStreak,
    nextAction: task.nextAction,
    readiness: computeReadiness(task),
    problemOverview: computeOverview(task),
    explanation: task.explanation,
    nextStart: task.nextStart,
  };
}

function renderStatusLines(profile: Profile, theme: Theme, width: number): string[] {
  const due = dueNodes(profile);
  const inner = Math.max(30, width - 2);
  const bar = theme.fg("borderMuted", "│");
  const line = (body: string): string => {
    const content = ` ${body}`;
    const padding = " ".repeat(Math.max(0, inner - visibleWidth(content)));
    return bar + truncateToWidth(content + padding, inner) + bar;
  };

  const rows = [theme.fg("borderMuted", `╭${"─".repeat(inner)}╮`)];
  rows.push(line(theme.bold(theme.fg("accent", "广东高考学习教员"))));

  if (!profile.initialized) {
    rows.push(line(theme.fg("warning", theme.bold("⚠ 尚未初始化"))));
    rows.push(line(theme.fg("muted", "输入 /coach 开始初始化引导")));
  } else {
    const states = Object.values(profile.knowledge).reduce<Record<string, number>>((acc, node) => {
      acc[node.state] = (acc[node.state] ?? 0) + 1;
      return acc;
    }, {});
    rows.push(line(theme.fg("success", `已初始化 · ${profile.learner.name}`)));
    rows.push(
      line(
        theme.fg(
          due.length ? "warning" : "success",
          `到期 ${due.length} 项 · 已掌握 ${states.mastered ?? 0} 项 · 复习中 ${states.review ?? 0} 项`,
        ),
      ),
    );
    if (profile.teaching.activeTask) {
      rows.push(line(theme.fg("muted", `当前：${profile.teaching.activeTask.knowledgeId}`)));
    }
    if (planReviewDue(profile)) rows.push(line(theme.fg("warning", "学习计划已到复盘时间")));
  }

  rows.push(theme.fg("borderMuted", `╰${"─".repeat(inner)}╯`));
  return rows;
}

function refreshWidget(ctx: ExtensionContext, profile: Profile): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget("coach-status", (_tui, theme) => ({
    invalidate() {},
    render: (width: number) => renderStatusLines(profile, theme, width),
  }));
}

function appendTurnEvidence(profile: Profile, task: ActiveTask, turn: ReturnType<typeof applyTurn>): void {
  const node = profile.knowledge[task.knowledgeId];
  if (!node) throw new Error(`状态中缺少知识节点：${task.knowledgeId}`);
  node.lastPractice = turn.date;
  if (turn.attemptDepth === "generative") node.attempts += 1;
  node.evidence.push({
    date: turn.date,
    taskId: task.id,
    phase: task.phase,
    attemptDepth: turn.attemptDepth,
    progress: turn.progress,
    correct: turn.correct,
    independent: turn.independent,
    kinds: turn.evidenceKinds,
    questionRole: turn.questionRole,
    note: turn.note,
  });
}

const ProblemMapSchema = Type.Object({
  goal: Type.String({ minLength: 1, description: "本任务要解决什么" }),
  known: Type.String({ minLength: 1, description: "题目或材料给了什么" }),
  missing: Type.String({ minLength: 1, description: "还缺什么或要求什么" }),
  concept: Type.String({ minLength: 1, description: "核心概念" }),
  relation: Type.String({ minLength: 1, description: "关键关系" }),
});

const PlanFocusSchema = Type.Object({
  knowledgeId: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
});

const TurnAuditLabelsSchema = Type.Object({
  correct: Type.Boolean(),
  attemptDepth: StringEnum(ATTEMPT_DEPTHS),
  progress: StringEnum(PROGRESS_STATES),
  independent: Type.Boolean(),
  evidenceKinds: Type.Array(StringEnum(EVIDENCE_KINDS), { maxItems: 8 }),
});

const ReviewAuditLabelsSchema = Type.Object({
  independent: Type.Boolean(),
  retrievalCorrect: Type.Boolean(),
  reasonPassed: Type.Boolean(),
  transferPassed: Type.Boolean(),
  boundaryPassed: Type.Boolean(),
});

const AuditArbitrationSchema = Type.Object({
  dimension: StringEnum(AUDIT_DIMENSIONS),
  decision: StringEnum(ARBITRATION_DECISIONS),
  evidenceQuote: Type.String({ minLength: 1, description: "裁定所依据的学员原话引用" }),
});

function buildAuditRecord(input: {
  kind: AuditKind;
  task: ActiveTask;
  questionRef: string | undefined;
  coach: TurnAuditLabels | ReviewAuditLabels;
  auditor: TurnAuditLabels | ReviewAuditLabels;
  arbitrations: AuditArbitration[];
  now: string;
}): AuditRecord {
  const differing = differingDimensions(input.kind, input.coach, input.auditor);
  const missing = missingArbitrations(differing, input.arbitrations);
  if (missing.length > 0) {
    throw new Error(`仲裁缺失维度：${missing.join("、")}。每个分歧维度都必须引用学员原话仲裁。`);
  }
  const extra = input.arbitrations.filter((item) => !differing.includes(item.dimension));
  if (extra.length > 0) {
    throw new Error(
      `判定一致的维度不需要仲裁：${extra.map((item) => item.dimension).join("、")}。`,
    );
  }
  for (const item of input.arbitrations) {
    if (!item.evidenceQuote.trim()) throw new Error(`仲裁 ${item.dimension} 缺少学员原话引用`);
  }
  return {
    id: uniqueId("audit"),
    date: input.now,
    kind: input.kind,
    taskId: input.task.id,
    knowledgeId: input.task.knowledgeId,
    questionRef: input.questionRef,
    coach: input.coach,
    auditor: input.auditor,
    arbitrations: input.arbitrations,
    agreed: differing.length === 0,
  };
}

const getStateTool = defineTool({
  name: "coach_get_state",
  label: "Coach: Get State",
  description:
    "读取初始化、分科基础、计划、当前教学任务、知识状态、到期复习和近期主观状态。教学开始前必须调用。决定科目难度前使用 subject 范围。",
  parameters: Type.Object({
    scope: Type.Optional(StringEnum(["summary", "subject", "full"] as const)),
    subject: Type.Optional(Type.String({ description: "scope=subject 时必填" })),
  }),
  async execute(_callId, params, _signal, _onUpdate, ctx) {
    const profile = readState(ctx);
    const due = dueNodes(profile);
    const summary = {
      initialized: profile.initialized,
      learner: profile.learner,
      plan: profile.plan,
      planReviewDue: planReviewDue(profile),
      activeTask: taskSummary(profile.teaching.activeTask),
      pausedTasks: profile.teaching.pausedTasks.map((task) => ({
        id: task.id,
        knowledgeId: task.knowledgeId,
        blockedBy: task.blockedBy,
        pauseReason: task.pauseReason,
        nextStart: task.nextStart,
      })),
      recentCompletedTasks: profile.teaching.completedTasks.slice(-3).map((task) => ({
        id: task.id,
        knowledgeId: task.knowledgeId,
        mode: task.mode,
        explanation: task.explanation
          ? { gate: task.explanation.gate, completedAt: task.explanation.completedAt }
          : null,
        updatedAt: task.updatedAt,
      })),
      knowledgeStats: Object.values(profile.knowledge).reduce<Record<string, number>>((acc, node) => {
        acc[node.state] = (acc[node.state] ?? 0) + 1;
        return acc;
      }, {}),
      catalogMissingIds: Object.values(profile.knowledge)
        .filter((node) => node.catalogMissing)
        .map((node) => node.id),
      dueReviews: due.map((node) => ({
        id: node.id,
        subject: node.subject,
        name: node.name,
        state: node.state,
        spacedPasses: node.spacedPasses,
        nextReview: node.nextReview,
      })),
      recentSessions: profile.sessions.slice(-3),
      recentEmotionalSignals: recentEmotionalSignals(profile),
      pacing: recentFeelingPolicy(profile),
      gradingAudit: auditStats(readAuditLog(ctx.cwd)),
    };

    if (params.scope === "full") {
      return {
        content: [{ type: "text", text: boundedJson({ ...summary, profile }) }],
        details: { profile, summary },
      };
    }

    if (params.scope === "subject") {
      if (!params.subject?.trim()) throw new Error("scope=subject 时必须提供 subject");
      const catalog = loadCatalog(ctx.cwd);
      const subject = params.subject.trim();
      const subjectState = {
        ...summary,
        selectedSubject: subject,
        baseline: profile.learner.baseline.bySubject[subject] ?? null,
        schoolProgress: profile.learner.schoolProgress[subject] ?? null,
        knowledge: Object.values(profile.knowledge).filter((node) => node.subject === subject),
        catalog: catalog.nodes.filter((node) => node.subject === subject),
      };
      return {
        content: [{ type: "text", text: boundedJson(subjectState) }],
        details: { profile, subjectState },
      };
    }

    return {
      content: [{ type: "text", text: boundedJson(summary) }],
      details: { profile, summary },
    };
  },
});

const completeInitTool = defineTool({
  name: "coach_complete_init",
  label: "Coach: Complete Init",
  description:
    "完成严格初始化并生成首个两周计划。姓名、选科、时长、时段、六科基础、六科校内进度、长期目标、主攻和里程碑都必须齐全。",
  parameters: Type.Object({
    name: Type.String({ minLength: 1 }),
    firstElective: StringEnum(FIRST_ELECTIVES),
    secondElectives: Type.Array(StringEnum(SECOND_ELECTIVES), { minItems: 2, maxItems: 2 }),
    dailyMinutes: Type.Integer({ minimum: 1, maximum: 1440 }),
    preferredTime: Type.String({ minLength: 1 }),
    baselineBySubject: Type.Array(
      Type.Object({
        subject: Type.String({ minLength: 1 }),
        note: Type.String({ minLength: 1 }),
        source: StringEnum(BASELINE_SOURCES),
      }),
      { minItems: 6, maxItems: 6 },
    ),
    schoolProgressBySubject: Type.Array(
      Type.Object({ subject: Type.String({ minLength: 1 }), note: Type.String({ minLength: 1 }) }),
      { minItems: 6, maxItems: 6 },
    ),
    longTermGoal: Type.String({ minLength: 1 }),
    initialFocus: Type.Array(PlanFocusSchema, { minItems: 1, maxItems: 3 }),
    milestoneTitle: Type.String({ minLength: 1 }),
    milestoneKnowledgeIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    milestoneSuccessCriteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  }),
  async execute(_callId, params, _signal, _onUpdate, ctx) {
    const catalog = loadCatalog(ctx.cwd);
    const { profile } = await mutateProfile(
      ctx,
      (profile) => {
        if (profile.initialized) throw new Error("初始化已经完成。后续计划变更必须使用 coach_update_plan。");

        requireNonBlank(params.name, "姓名");
        requireNonBlank(params.preferredTime, "偏好时段");
        requireNonBlank(params.longTermGoal, "长期目标");
        requireNonBlank(params.milestoneTitle, "里程碑标题");
        params.baselineBySubject.forEach((item) => requireNonBlank(item.note, `${item.subject} 基础诊断`));
        params.schoolProgressBySubject.forEach((item) => requireNonBlank(item.note, `${item.subject} 校内进度`));
        params.initialFocus.forEach((item) => requireNonBlank(item.reason, `${item.knowledgeId} 主攻原因`));
        params.milestoneSuccessCriteria.forEach((item) => requireNonBlank(item, "里程碑通过标准"));
        if (new Set(params.initialFocus.map((item) => item.knowledgeId)).size !== params.initialFocus.length) {
          throw new Error("初始主攻节点不能重复");
        }

        const second = params.secondElectives.map((item) => item.trim());
        if (new Set(second).size !== 2) throw new Error("再选科目不能重复");
        const subjects = ["语文", "数学", "英语", params.firstElective, ...second];
        const required = new Set(subjects);

        const baselineSubjects = params.baselineBySubject.map((item) => item.subject.trim());
        const progressSubjects = params.schoolProgressBySubject.map((item) => item.subject.trim());
        if (baselineSubjects.length !== new Set(baselineSubjects).size) throw new Error("基础诊断科目不能重复");
        if (progressSubjects.length !== new Set(progressSubjects).size) throw new Error("校内进度科目不能重复");
        if (baselineSubjects.some((subject) => !required.has(subject)) || required.size !== baselineSubjects.length) {
          throw new Error(`基础诊断必须恰好覆盖六科：${subjects.join("、")}`);
        }
        if (progressSubjects.some((subject) => !required.has(subject)) || required.size !== progressSubjects.length) {
          throw new Error(`校内进度必须恰好覆盖六科：${subjects.join("、")}`);
        }

        const initialFocus = params.initialFocus.map((focus) => {
          const definition = requireKnowledge(catalog, focus.knowledgeId);
          if (!required.has(definition.subject)) throw new Error(`主攻节点不属于备考科目：${focus.knowledgeId}`);
          return { knowledgeId: definition.id, reason: focus.reason };
        });
        if (new Set(initialFocus.map((item) => item.knowledgeId)).size !== initialFocus.length) {
          throw new Error("初始主攻节点解析别名后不能重复");
        }
        const milestoneKnowledgeIds = params.milestoneKnowledgeIds.map((id) => {
          const definition = requireKnowledge(catalog, id);
          if (!required.has(definition.subject)) throw new Error(`里程碑节点不属于备考科目：${id}`);
          return definition.id;
        });

        const now = nowIso();
        profile.learner = {
          name: params.name.trim(),
          grade: "高一",
          province: "广东",
          examMode: "3+1+2",
          firstElective: params.firstElective,
          secondElectives: second,
          subjects,
          baseline: {
            globalNote: "初始化记录。自述和校内结果只用于起始节奏，不作为掌握证据。",
            bySubject: Object.fromEntries(
              params.baselineBySubject.map((item) => [
                item.subject.trim(),
                {
                  note: item.note.trim(),
                  source: item.source as BaselineSource,
                  observedAt: now,
                },
              ]),
            ),
          },
          schoolProgress: Object.fromEntries(
            params.schoolProgressBySubject.map((item) => [item.subject.trim(), item.note.trim()]),
          ),
          schedule: { dailyMinutes: params.dailyMinutes, preferredTime: params.preferredTime.trim() },
        };
        profile.plan = createInitialPlan(
          {
            longTermGoal: params.longTermGoal,
            currentFocus: initialFocus,
            milestoneTitle: params.milestoneTitle,
            milestoneKnowledgeIds,
            milestoneSuccessCriteria: params.milestoneSuccessCriteria,
            subjectReviewNotes: Object.fromEntries(
              params.schoolProgressBySubject.map((item) => [item.subject.trim(), item.note.trim()]),
            ),
          },
          now,
        );
        profile.initialized = true;
        profile.sessions.push({ date: now, mode: "init", outcome: "初始化与首个两周计划完成" });
      },
      true,
    );

    return {
      content: [
        {
          type: "text",
          text: `初始化完成。备考科目：${profile.learner.subjects.join("、")}。首个两周计划已写入 学习计划.md。`,
        },
      ],
      details: { initialized: true, learner: profile.learner, plan: profile.plan },
    };
  },
});

const startTaskTool = defineTool({
  name: "coach_start_task",
  label: "Coach: Start Task",
  description:
    "开始一个规范知识节点的教学或到期复习任务。新教学节点必须在计划内。已确认前置节点和复习失败后的补强除外。",
  parameters: Type.Object({
    knowledgeId: Type.String({ minLength: 1 }),
    mode: StringEnum(TASK_MODES),
    goal: Type.String({ minLength: 1 }),
    problemMap: ProblemMapSchema,
  }),
  async execute(_callId, params, _signal, _onUpdate, ctx) {
    const catalog = loadCatalog(ctx.cwd);
    const { value } = await mutateProfile(ctx, (profile) => {
      ensureInitialized(profile);
      if (!profile.plan) throw new Error("学习计划缺失。先调用 coach_update_plan 修复计划。");
      if (profile.teaching.activeTask) {
        throw new Error(`已有活动任务 ${profile.teaching.activeTask.id}。先完成或暂停它。`);
      }

      const { definition, node, canonicalId } = getOrCreateKnowledge(profile, catalog, params.knowledgeId);
      if (!profile.learner.subjects.includes(definition.subject)) {
        throw new Error(`该知识节点不属于当前备考科目：${params.knowledgeId}`);
      }

      const blockedParent =
        params.mode === "teach"
          ? [...profile.teaching.pausedTasks].reverse().find((task) => task.blockedBy === canonicalId)
          : undefined;
      const inPlan = profile.plan.currentFocus.some((focus) => focus.knowledgeId === canonicalId);
      if (params.mode === "teach" && !blockedParent && recentFeelingPolicy(profile).protectedPacing) {
        const lastSessionTime = Date.parse(profile.sessions[profile.sessions.length - 1]?.date ?? "1970-01-01");
        const completedTeachThisSession = profile.teaching.completedTasks.some(
          (task) => task.mode === "teach" && Date.parse(task.updatedAt) > lastSessionTime,
        );
        if (completedTeachThisSession) {
          throw new Error("保护节奏下本次会话已经完成一个主教学目标。请结束会话或只做复习。");
        }
        const dueCount = Object.values(profile.knowledge).filter((node) => !node.catalogMissing && isDue(node.nextReview)).length;
        const completedReviewThisSession = profile.teaching.completedTasks.some(
          (task) => task.mode === "review" && Date.parse(task.updatedAt) > lastSessionTime,
        );
        if (dueCount > 0 && !completedReviewThisSession) {
          throw new Error("保护节奏下必须先完成一项到期复习，再开始新的主教学目标。");
        }
      }
      const lastReview = node.reviewHistory[node.reviewHistory.length - 1];
      const needsRemediation = node.state === "learning" && lastReview?.fullPass === false;
      if (params.mode === "teach" && !inPlan && !blockedParent && !needsRemediation) {
        throw new Error("新教学节点不在当前主攻中。先用 coach_update_plan 调整计划。");
      }
      if (params.mode === "review") {
        if (!node.localVerifiedAt || !node.localVerification) {
          throw new Error("该节点缺少完整本地验证记录，不能进入间隔复习");
        }
        if (!isDue(node.nextReview)) throw new Error(`该节点尚未到期：${node.nextReview ?? "未安排"}`);
      }
      if (node.state === "blocked" && !blockedParent) {
        throw new Error(`该节点仍被 ${node.blockedBy ?? "未知前置节点"} 阻塞`);
      }

      const now = nowIso();
      const pausedIndex = profile.teaching.pausedTasks.findIndex(
        (task) => task.knowledgeId === canonicalId && !task.blockedBy && task.mode === params.mode,
      );
      if (pausedIndex >= 0) {
        const resumed = profile.teaching.pausedTasks.splice(pausedIndex, 1)[0];
        if (resumed.pauseReason === "emotion" && resumed.updatedAt.slice(0, 10) === now.slice(0, 10)) {
          profile.teaching.pausedTasks.push(resumed);
          throw new Error("该任务因情绪在今天暂停。今天不要恢复同一任务，先做其他内容。");
        }
        resetTaskForResume(resumed, now);
        profile.teaching.activeTask = resumed;
        node.state = params.mode === "teach" ? "learning" : node.state;
        return { task: resumed, definition, resumed: true };
      }

      const task = createActiveTask({
        id: uniqueId("task"),
        knowledgeId: canonicalId,
        mode: params.mode,
        goal: params.goal,
        problemMap: params.problemMap,
        now,
        parentTaskId: params.mode === "teach" ? blockedParent?.id : undefined,
      });
      profile.teaching.activeTask = task;
      if (params.mode === "teach") node.state = "learning";
      return { task, definition };
    });

    return {
      content: [
        {
          type: "text",
          text: `已开始 ${params.mode === "review" ? "到期复习" : "教学"}任务 ${value.task.id}。先从问题、条件和关系提问。`,
        },
      ],
      details: value,
    };
  },
});

const recordTurnTool = defineTool({
  name: "coach_record_turn",
  label: "Coach: Record Turn",
  description:
    "记录每次学员回答。生成性尝试、微进展、无进展和拒绝都必须记录。该工具不更新 SM-2，也不直接判定掌握。",
  parameters: Type.Object({
    taskId: Type.String({ minLength: 1 }),
    questionKey: Type.String({ minLength: 1, description: "同一逻辑问题使用同一稳定键" }),
    questionRole: StringEnum(QUESTION_ROLES),
    guidanceMethod: StringEnum(GUIDANCE_METHODS),
    supportDepth: Type.Integer({ minimum: 0, maximum: 4 }),
    attemptDepth: StringEnum(ATTEMPT_DEPTHS),
    progress: StringEnum(PROGRESS_STATES),
    emotionalSignal: Type.Boolean(),
    refused: Type.Boolean(),
    correct: Type.Boolean(),
    independent: Type.Boolean(),
    evidenceKinds: Type.Array(StringEnum(EVIDENCE_KINDS), { maxItems: 8 }),
    overviewItems: Type.Array(StringEnum(OVERVIEW_ITEMS), { maxItems: 5 }),
    coreError: Type.Boolean(),
    pathId: Type.Optional(Type.String()),
    blockedRelation: Type.Optional(
      Type.String({
        description:
          "学员本轮未能跨越的那条关系。仅当 progress=none 且（questionRole=connection 或提供 pathId）时必填；progress=new 时无需填写。后续 authorize-explanation 的 keyRelation 必须与已登记值一致（去除首尾空格后精确相等），已登记值见 explanationEligibility.facts.recordedBlockedRelations。",
      }),
    ),
    candidatePrerequisiteId: Type.Optional(Type.String()),
    note: Type.Optional(Type.String()),
  }),
  async execute(_callId, params, _signal, _onUpdate, ctx) {
    const catalog = loadCatalog(ctx.cwd);
    const { value } = await mutateProfile(ctx, (profile) => {
      ensureInitialized(profile);
      const task = activeTaskOrThrow(profile, params.taskId);
      if (task.phase === "verify") throw new Error("讲后验证回答必须使用 coach_record_verification");

      let candidatePrerequisiteId: string | undefined;
      if (params.candidatePrerequisiteId) {
        const target = requireKnowledge(catalog, task.knowledgeId);
        const candidate = requireKnowledge(catalog, params.candidatePrerequisiteId);
        candidatePrerequisiteId = candidate.id;
        if (!target.prerequisites.includes(candidate.id)) {
          throw new Error(`${params.candidatePrerequisiteId} 不是 ${task.knowledgeId} 的直接前置节点`);
        }
      }

      const input: TurnInput = {
        questionKey: params.questionKey,
        questionRole: params.questionRole as QuestionRole,
        guidanceMethod: params.guidanceMethod as GuidanceMethod,
        supportDepth: params.supportDepth,
        attemptDepth: params.attemptDepth as AttemptDepth,
        progress: params.progress,
        emotionalSignal: params.emotionalSignal,
        refused: params.refused,
        correct: params.correct,
        independent: params.independent,
        evidenceKinds: params.evidenceKinds as EvidenceKind[],
        overviewItems: params.overviewItems as OverviewItem[],
        coreError: params.coreError,
        pathId: params.pathId,
        blockedRelation: params.blockedRelation,
        candidatePrerequisiteId,
        note: params.note,
      };
      const turn = applyTurn(task, input, nowIso(), uniqueId("turn"));
      appendTurnEvidence(profile, task, turn);
      return {
        task: taskSummary(task),
        turn,
        explanationEligibility: computeExplanationEligibility(task, task.problemMap.relation),
      };
    });

    return {
      content: [
        {
          type: "text",
          text: `已记录本轮。有效尝试 ${value.task?.effectiveAttempts ?? 0}，微进展 ${value.task?.microProgress ?? 0}，连续无进展 ${value.task?.noProgressStreak ?? 0}。下一动作：${value.task?.nextAction}。`,
        },
      ],
      details: value,
    };
  },
});

const transitionTool = defineTool({
  name: "coach_transition",
  label: "Coach: Transition",
  description:
    "执行受约束的教学状态转换：授权一次简讲、确认前置阻塞、完成本地验证或暂停任务。工具会检查门槛。",
  parameters: Type.Object({
    taskId: Type.String({ minLength: 1 }),
    action: StringEnum(TRANSITION_ACTIONS),
    gate: Type.Optional(StringEnum(EXPLANATION_GATES)),
    keyRelation: Type.Optional(
      Type.String({
        description:
          "本次只讲的一条关键关系。讲解组 A/C 以它与 record_turn 已登记的 blockedRelation 精确匹配（去除首尾空格）。被拒绝时，从错误信息 facts.recordedBlockedRelations 中直接引用已登记值。",
      }),
    ),
    prerequisiteId: Type.Optional(Type.String()),
    pauseReason: Type.Optional(StringEnum(PAUSE_REASONS)),
    reason: Type.Optional(Type.String()),
    nextStart: Type.Optional(Type.String()),
  }),
  async execute(_callId, params, _signal, _onUpdate, ctx) {
    const catalog = loadCatalog(ctx.cwd);
    const syncPlan = false;
    const { value } = await mutateProfile(ctx, (profile) => {
      ensureInitialized(profile);
      const task = activeTaskOrThrow(profile, params.taskId);
      const now = nowIso();

      if (params.action === "authorize-explanation") {
        if (task.mode === "review") {
          throw new Error("到期复习必须先记录独立评估结果。失败后再开始补强教学任务。");
        }
        if (task.explanation) throw new Error("该任务已经获得一次讲解。验证失败时不得重讲。");
        const gate = params.gate as ExplanationGate | undefined;
        const keyRelation = params.keyRelation?.trim();
        if (!gate || !keyRelation) throw new Error("授权讲解必须提供 gate 和 keyRelation");

        if (gate === "prerequisite") {
          const parent = profile.teaching.pausedTasks.find((item) => item.id === task.parentTaskId);
          if (!parent || parent.blockedBy !== task.knowledgeId) {
            throw new Error("当前任务不是已确认的前置小目标");
          }
          const parentDiagnostics = parent.turns.filter(
            (turn) =>
              turn.questionRole === "prerequisite-diagnostic" &&
              turn.candidatePrerequisiteId === task.knowledgeId &&
              turn.progress === "none",
          ).length;
          const childDiagnostics = task.turns.filter(
            (turn) =>
              turn.questionRole === "prerequisite-diagnostic" && turn.progress === "none",
          ).length;
          if ((parentDiagnostics < 2 && childDiagnostics < 2) || task.noProgressStreak < 1) {
            throw new Error("前置简讲前必须有一轮失败的最小诊断，并存在两个失败诊断证据");
          }
        } else {
          const eligibility = computeExplanationEligibility(task, keyRelation);
          if (!eligibility.groups[gate]) {
            throw new Error(`讲解组 ${gate} 未满足：${eligibility.prohibitions.join("；") || JSON.stringify(eligibility.facts)}`);
          }
        }

        task.explanation = createExplanation(gate, keyRelation, now);
        task.phase = "verify";
        task.nextAction = "verify-explanation";
        task.updatedAt = now;
        return { action: params.action, task: taskSummary(task) };
      }

      if (params.action === "block-for-prerequisite") {
        if (task.mode === "review") {
          throw new Error("到期复习评估不得改判前置阻塞。先记录评估结果，再开补强教学。");
        }
        if (task.phase === "verify" || task.explanation) {
          throw new Error("讲后验证期间不能改判前置阻塞。只能继续验证或暂停。");
        }
        if (profile.teaching.pausedTasks.length >= 20) {
          throw new Error("暂停任务过多。先恢复或关闭部分任务。");
        }
        const requestedPrerequisiteId = params.prerequisiteId?.trim();
        if (!requestedPrerequisiteId) throw new Error("必须提供 prerequisiteId");
        if (!params.nextStart?.trim()) throw new Error("前置阻塞必须记录原任务的下次起点");
        if (task.noProgressStreak < 4) throw new Error("连续无进展未达到四轮，不能确认前置阻塞");

        const target = requireKnowledge(catalog, task.knowledgeId);
        const prerequisite = requireKnowledge(catalog, requestedPrerequisiteId);
        const prerequisiteId = prerequisite.id;
        if (!target.prerequisites.includes(prerequisiteId)) {
          throw new Error(`${requestedPrerequisiteId} 不是 ${task.knowledgeId} 的直接前置节点`);
        }
        const diagnostics = task.turns.filter(
          (turn) =>
            turn.questionRole === "prerequisite-diagnostic" &&
            turn.candidatePrerequisiteId === prerequisiteId &&
            turn.progress === "none",
        ).length;
        if (diagnostics < 2) throw new Error("确认前置阻塞前必须有两个失败的最小诊断问题");

        task.phase = "paused";
        task.blockedBy = prerequisiteId;
        task.nextStart = params.nextStart.trim();
        task.pauseReason = "prerequisite";
        task.updatedAt = now;
        const node = profile.knowledge[task.knowledgeId];
        node.state = "blocked";
        node.blockedBy = prerequisiteId;
        profile.teaching.pausedTasks.push(task);
        profile.teaching.activeTask = null;
        return { action: params.action, blockedTask: taskSummary(task), prerequisiteId };
      }

      if (params.action === "finish-verified") {
        const check = canFinishLocally(task);
        if (!check.allowed) throw new Error(`不能完成本地验证：${check.reasons.join("；")}`);
        const node = profile.knowledge[task.knowledgeId];
        node.localVerifiedAt = now;
        node.localVerification = {
          taskId: task.id,
          completedAt: now,
          method: task.explanation ? "explained" : "socratic",
          explanationGate: task.explanation?.gate,
          nearTransferPassed: true,
          verification: task.explanation ? { ...task.explanation.verification } : undefined,
        };
        node.state = "review";
        node.blockedBy = undefined;
        node.repetitions = 0;
        node.intervalDays = 0;
        node.spacedPasses = 0;
        node.nextReview = addDays(now, 1);
        archiveTask(profile, task, now);
        profile.teaching.activeTask = null;

        const parentIndex = profile.teaching.pausedTasks.findIndex(
          (item) => item.id === task.parentTaskId && item.blockedBy === task.knowledgeId,
        );
        let resumedTask: ActiveTask | null = null;
        if (parentIndex >= 0) {
          resumedTask = profile.teaching.pausedTasks.splice(parentIndex, 1)[0];
          resetTaskForResume(resumedTask, now);
          profile.teaching.activeTask = resumedTask;
          const parentNode = profile.knowledge[resumedTask.knowledgeId];
          parentNode.state = "learning";
          parentNode.blockedBy = undefined;
        }
        return {
          action: params.action,
          knowledgeId: task.knowledgeId,
          nextReview: node.nextReview,
          resumedTask: taskSummary(resumedTask),
        };
      }

      if (params.action === "discard-paused") {
        if (!params.taskId?.trim()) throw new Error("必须提供 taskId");
        const index = profile.teaching.pausedTasks.findIndex((item) => item.id === params.taskId);
        if (index < 0) throw new Error("该任务不在暂停任务列表中");
        const discarded = profile.teaching.pausedTasks.splice(index, 1)[0];
        archiveTask(profile, discarded, now);
        if (discarded.blockedBy) {
          const node = profile.knowledge[discarded.knowledgeId];
          if (node) {
            node.state = node.catalogMissing ? node.state : "learning";
            node.blockedBy = undefined;
          }
        }
        return { action: params.action, discardedTask: taskSummary(discarded) };
      }

      if (!params.nextStart?.trim()) throw new Error("暂停任务必须记录 nextStart");
      if (profile.teaching.pausedTasks.length >= 20) {
        throw new Error("暂停任务过多。先恢复或关闭部分任务。");
      }
      task.phase = "paused";
      task.nextStart = params.nextStart.trim();
      task.pauseReason = params.pauseReason ?? "manual";
      task.updatedAt = now;
      profile.teaching.pausedTasks.push(task);
      profile.teaching.activeTask = null;
      return { action: params.action, reason: params.reason?.trim(), pausedTask: taskSummary(task) };
    }, syncPlan);

    return {
      content: [{ type: "text", text: `教学状态转换完成：${params.action}。` }],
      details: value,
    };
  },
});

const recordVerificationTool = defineTool({
  name: "coach_record_verification",
  label: "Coach: Record Verification",
  description:
    "记录讲后五步验证。必须按复述、理由、近迁移、反例、回原题的顺序调用。失败后只处理该步骤，不能重讲。",
  parameters: Type.Object({
    taskId: Type.String({ minLength: 1 }),
    step: StringEnum(VERIFICATION_STEPS),
    questionKey: Type.String({ minLength: 1 }),
    passed: Type.Boolean(),
    attemptDepth: StringEnum(ATTEMPT_DEPTHS),
    refused: Type.Boolean(),
    independent: Type.Boolean(),
    supportDepth: Type.Integer({ minimum: 0, maximum: 4 }),
    guidanceMethod: StringEnum(GUIDANCE_METHODS),
    coreError: Type.Boolean(),
    note: Type.Optional(Type.String()),
  }),
  async execute(_callId, params, _signal, _onUpdate, ctx) {
    const { value } = await mutateProfile(ctx, (profile) => {
      ensureInitialized(profile);
      const task = activeTaskOrThrow(profile, params.taskId);
      if (!task.explanation || task.phase !== "verify") throw new Error("当前任务不在讲后验证阶段");
      if (
        params.passed &&
        (params.attemptDepth !== "generative" || params.refused || !params.independent)
      ) {
        throw new Error("通过验证必须来自学员独立完成的生成性回答");
      }

      const step = params.step as VerificationStep;
      if (params.passed && task.explanation.verification[step] === "failed") {
        const sameKeyTurns = task.turns.filter(
          (turn) => turn.questionRole === "verification" && turn.questionKey === params.questionKey,
        ).length;
        if (sameKeyTurns < 2) {
          throw new Error("失败步骤重试通过前，必须先记录至少一轮补救尝试");
        }
      }
      const kindByStep: Record<VerificationStep, EvidenceKind> = {
        restate: "reconstruct",
        reason: "reason",
        "near-transfer": "near-transfer",
        counterexample: "counterexample",
        return: "apply",
      };
      const input: TurnInput = {
        questionKey: params.questionKey,
        questionRole: "verification",
        guidanceMethod: params.guidanceMethod as GuidanceMethod,
        supportDepth: params.supportDepth,
        attemptDepth: params.attemptDepth as AttemptDepth,
        progress: params.passed ? "new" : "none",
        emotionalSignal: false,
        refused: params.refused,
        correct: params.passed,
        independent: params.independent,
        evidenceKinds: params.passed
          ? task.unresolvedCoreError
            ? [kindByStep[step], "self-correct"]
            : [kindByStep[step]]
          : ["error"],
        overviewItems: [],
        coreError: params.coreError,
        note: params.note,
      };
      const now = nowIso();
      const turn = applyTurn(task, input, now, uniqueId("turn"));
      appendTurnEvidence(profile, task, turn);
      recordVerificationStatus(task.explanation, step, params.passed, now);
      task.nextAction = task.refusalStreak >= 2 ? "pause-for-emotion" : "verify-explanation";
      if (allVerificationPassed(task.explanation)) task.nextAction = "finish-or-continue";

      return {
        task: taskSummary(task),
        step,
        passed: params.passed,
        allPassed: allVerificationPassed(task.explanation),
        remediation: params.passed ? null : verificationRemediation(step),
      };
    });

    return {
      content: [
        {
          type: "text",
          text: value.passed
            ? `验证 ${value.step} 通过。${value.allPassed ? "五步已全部通过，可以完成本地验证。" : "继续下一步。"}`
            : `验证 ${value.step} 未通过。${value.remediation}`,
        },
      ],
      details: value,
    };
  },
});

const recordReviewTool = defineTool({
  name: "coach_record_review",
  label: "Coach: Record Spaced Review",
  description:
    "每个到期节点只调用一次。工具从本任务已记录回答计算独立检索、理由、近迁移和边界结果，再推进一次 SM-2。",
  parameters: Type.Object({
    taskId: Type.String({ minLength: 1 }),
    auditId: Type.String({
      minLength: 1,
      description: "coach_audit_review 返回的审计编号。复习计分必须携带本次盲评复评的审计编号。",
    }),
    note: Type.Optional(Type.String()),
  }),
  async execute(_callId, params, _signal, _onUpdate, ctx) {
    const { value } = await mutateProfile(ctx, (profile) => {
      ensureInitialized(profile);
      const task = activeTaskOrThrow(profile, params.taskId);
      if (task.mode !== "review") throw new Error("当前任务不是到期复习任务");
      const node = profile.knowledge[task.knowledgeId];
      if (!node?.localVerifiedAt || !node.localVerification) {
        throw new Error("该节点缺少完整本地验证记录");
      }
      if (!isDue(node.nextReview)) throw new Error(`该节点尚未到期：${node.nextReview ?? "未安排"}`);

      if (task.rounds === 0) throw new Error("复习任务尚未记录任何学员回答");
      const successfulTurns = task.turns.filter(
        (turn) =>
          turn.attemptDepth === "generative" &&
          turn.correct &&
          turn.independent &&
          turn.progress === "new" &&
          !turn.coreError &&
          turn.evidenceKinds.length > 0,
      );
      if (successfulTurns.length < 4) {
        throw new Error(
          `完整复习评估需要至少四轮独立生成性作答。当前仅 ${successfulTurns.length} 轮。`,
        );
      }

      const auditId = params.auditId?.trim();
      if (!auditId) {
        throw new Error("复习计分必须携带审计编号。先用 grading-auditor 子代理盲评五标准，再调用 coach_audit_review。");
      }
      const audit = readAuditLog(ctx.cwd).find((record) => record.id === auditId);
      if (!audit) {
        throw new Error(`审计编号不存在：${auditId}。复习复评返回的编号必须原样携带。`);
      }
      if (audit.kind !== "review" || audit.taskId !== task.id || audit.knowledgeId !== task.knowledgeId) {
        throw new Error("该审计不属于本复习任务。复习计分必须携带本任务的 coach_audit_review 审计编号。");
      }
      if (audit.date < task.startedAt) {
        throw new Error("该审计早于本复习任务的开始时间，不能用于本次计分");
      }
      const independentPass = (kinds: EvidenceKind[]) =>
        task.turns.some(
          (turn) =>
            turn.attemptDepth === "generative" &&
            turn.correct &&
            turn.independent &&
            turn.progress === "new" &&
            !turn.coreError &&
            kinds.some((kind) => turn.evidenceKinds.includes(kind)),
        );
      const reviewEvidence = {
        independent:
          task.turns.length > 0 &&
          task.turns.every(
            (turn) =>
              turn.correct &&
              turn.independent &&
              turn.progress === "new" &&
              !turn.refused &&
              !turn.coreError,
          ),
        retrievalCorrect: independentPass(["define", "relate", "apply", "reconstruct"]),
        reasonPassed: independentPass(["reason", "derive"]),
        transferPassed: independentPass(["near-transfer"]),
        boundaryPassed: independentPass(["boundary", "counterexample"]),
      };
      const dueAt = node.nextReview!;
      const result = reviewQuality(reviewEvidence);
      const schedule = sm2({
        quality: result.quality,
        ease: node.ease,
        intervalDays: node.intervalDays,
        repetitions: node.repetitions,
      });
      const now = nowIso();
      node.ease = schedule.ease;
      node.intervalDays = schedule.intervalDays;
      node.repetitions = schedule.repetitions;
      node.reviews += 1;
      node.lastReview = now;
      node.nextReview = addDays(now, schedule.intervalDays);
      node.spacedPasses = result.fullPass ? node.spacedPasses + 1 : 0;
      node.state =
        result.fullPass && node.localVerification && node.spacedPasses >= REQUIRED_SPACED_PASSES
          ? "mastered"
          : result.fullPass
            ? "review"
            : "learning";
      node.reviewHistory.push({
        date: now,
        dueAt,
        independent: reviewEvidence.independent,
        retrievalCorrect: reviewEvidence.retrievalCorrect,
        reasonPassed: reviewEvidence.reasonPassed,
        transferPassed: reviewEvidence.transferPassed,
        boundaryPassed: reviewEvidence.boundaryPassed,
        fullPass: result.fullPass,
        quality: result.quality,
      });
      node.evidence.push({
        date: now,
        taskId: task.id,
        phase: "review",
        attemptDepth: reviewEvidence.retrievalCorrect ? "generative" : "none",
        progress: result.fullPass ? "new" : "none",
        correct: result.fullPass,
        independent: result.fullPass,
        kinds: result.fullPass ? ["reason", "near-transfer", "boundary"] : ["error"],
        questionRole: "core",
        note: params.note?.trim() || undefined,
      });
      archiveTask(profile, task, now);
      profile.teaching.activeTask = null;

      return {
        knowledgeId: node.id,
        fullPass: result.fullPass,
        spacedPasses: node.spacedPasses,
        requiredSpacedPasses: REQUIRED_SPACED_PASSES,
        state: node.state,
        intervalDays: node.intervalDays,
        nextReview: node.nextReview,
        evidence: reviewEvidence,
        auditId: audit.id,
        auditAgreed: audit.agreed,
      };
    });

    return {
      content: [
        {
          type: "text",
          text: value.fullPass
            ? `完整间隔复习通过。连续间隔通过 ${value.spacedPasses}/${value.requiredSpacedPasses}，状态 ${value.state}。`
            : `本次间隔复习未完整通过。状态回到 learning，明天再检查。`,
        },
      ],
      details: value,
    };
  },
});

const auditTurnTool = defineTool({
  name: "coach_audit_turn",
  label: "Coach: Audit Turn",
  description:
    "教学回合抽检：记录执教判定与复评员（grading-auditor 子代理）盲评的逐维比较。有效尝试每满 3 次时对该回合调用。分歧维度必须仲裁并引用学员原话。",
  parameters: Type.Object({
    taskId: Type.String({ minLength: 1 }),
    questionRef: Type.String({ minLength: 1, description: "被抽审回合的 questionKey" }),
    coachLabels: TurnAuditLabelsSchema,
    auditorLabels: TurnAuditLabelsSchema,
    arbitrations: Type.Array(AuditArbitrationSchema, { maxItems: 8 }),
  }),
  async execute(_callId, params, _signal, _onUpdate, ctx) {
    const profile = readState(ctx);
    ensureInitialized(profile);
    const task = activeTaskOrThrow(profile, params.taskId);
    if (task.mode !== "teach") {
      throw new Error("回合抽检只用于教学任务。复习任务使用 coach_audit_review。");
    }
    const questionRef = params.questionRef.trim();
    const turn = [...task.turns].reverse().find((item) => item.questionKey === questionRef);
    if (!turn) throw new Error(`当前任务没有 questionKey 为 ${questionRef} 的已记录回合`);

    const records = readAuditLog(ctx.cwd);
    const duplicated = records.some(
      (record) =>
        record.kind === "turn-sample" && record.taskId === task.id && record.questionRef === questionRef,
    );
    if (duplicated) throw new Error("该回合已复评过，不得重复审计");

    const record = buildAuditRecord({
      kind: "turn-sample",
      task,
      questionRef,
      coach: params.coachLabels as TurnAuditLabels,
      auditor: params.auditorLabels as TurnAuditLabels,
      arbitrations: params.arbitrations as AuditArbitration[],
      now: nowIso(),
    });
    await withFileMutationQueue(gradingAuditPath(ctx.cwd), async () => {
      appendAuditRecord(ctx.cwd, record);
    });
    const stats = auditStats([...records, record]);

    return {
      content: [
        {
          type: "text",
          text: record.agreed
            ? `复评一致。一致性累计 ${stats.agreed}/${stats.total}。`
            : `复评存在分歧并已仲裁：${differingDimensions("turn-sample", record.coach as TurnAuditLabels, record.auditor as TurnAuditLabels).join("、")}。一致性累计 ${stats.agreed}/${stats.total}。`,
        },
      ],
      details: { audit: record, stats },
    };
  },
});

const auditReviewTool = defineTool({
  name: "coach_audit_review",
  label: "Coach: Audit Review",
  description:
    "复习复评：在复习回合全部记录后、coach_record_review 之前调用。记录执教判定与复评员盲评的逐维比较，返回审计编号。分歧维度必须仲裁并引用学员原话。",
  parameters: Type.Object({
    taskId: Type.String({ minLength: 1 }),
    coachLabels: ReviewAuditLabelsSchema,
    auditorLabels: ReviewAuditLabelsSchema,
    arbitrations: Type.Array(AuditArbitrationSchema, { maxItems: 8 }),
  }),
  async execute(_callId, params, _signal, _onUpdate, ctx) {
    const profile = readState(ctx);
    ensureInitialized(profile);
    const task = activeTaskOrThrow(profile, params.taskId);
    if (task.mode !== "review") throw new Error("复习复评只用于到期复习任务");

    const successfulTurns = task.turns.filter(
      (turn) =>
        turn.attemptDepth === "generative" &&
        turn.correct &&
        turn.independent &&
        turn.progress === "new" &&
        !turn.coreError &&
        turn.evidenceKinds.length > 0,
    );
    if (successfulTurns.length < 4) {
      throw new Error(
        `先完成全部复习回合并记录，再复评。当前独立生成性作答 ${successfulTurns.length} 轮（需 ≥4）。`,
      );
    }

    const records = readAuditLog(ctx.cwd);
    const lastTurnAt = task.turns[task.turns.length - 1]?.date;
    const covered = records.some(
      (record) =>
        record.kind === "review" && record.taskId === task.id && lastTurnAt !== undefined && record.date >= lastTurnAt,
    );
    if (covered) {
      throw new Error("本任务已完成覆盖最新回合的复习复评。仲裁后补问回合的，先记录新回合再复评。");
    }

    const record = buildAuditRecord({
      kind: "review",
      task,
      questionRef: undefined,
      coach: params.coachLabels as ReviewAuditLabels,
      auditor: params.auditorLabels as ReviewAuditLabels,
      arbitrations: params.arbitrations as AuditArbitration[],
      now: nowIso(),
    });
    await withFileMutationQueue(gradingAuditPath(ctx.cwd), async () => {
      appendAuditRecord(ctx.cwd, record);
    });
    const stats = auditStats([...records, record]);

    return {
      content: [
        {
          type: "text",
          text: `复习复评完成。审计编号 ${record.id}，在 coach_record_review 中携带。${record.agreed ? "复评一致。" : "分歧已仲裁，以仲裁后判定为准。"}一致性累计 ${stats.agreed}/${stats.total}。`,
        },
      ],
      details: { audit: record, stats },
    };
  },
});

const updatePlanTool = defineTool({
  name: "coach_update_plan",
  label: "Coach: Update Plan",
  description:
    "创建或复盘两周学习计划，并同步 学习计划.md。每周、月考后或主攻变化时调用。计划只用规范 knowledgeId。",
  parameters: Type.Object({
    reason: StringEnum(PLAN_REASONS),
    longTermGoal: Type.Optional(Type.String({ minLength: 1 })),
    currentFocus: Type.Array(PlanFocusSchema, { minItems: 1, maxItems: 3 }),
    milestoneUpdates: Type.Array(
      Type.Object({
        id: Type.String({ minLength: 1 }),
        status: StringEnum(MILESTONE_STATUSES),
        targetDate: Type.Optional(Type.String({ minLength: 1, description: "ISO 日期或时间" })),
        successCriteria: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
        note: Type.Optional(Type.String()),
      }),
    ),
    newMilestones: Type.Array(
      Type.Object({
        title: Type.String({ minLength: 1 }),
        knowledgeIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        successCriteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        targetDate: Type.String({ minLength: 1, description: "ISO 日期或时间" }),
      }),
    ),
    subjectReviews: Type.Array(
      Type.Object({ subject: Type.String({ minLength: 1 }), note: Type.String({ minLength: 1 }) }),
      { minItems: 6, maxItems: 6 },
    ),
    reflection: Type.String({ minLength: 1 }),
  }),
  async execute(_callId, params, _signal, _onUpdate, ctx) {
    const catalog = loadCatalog(ctx.cwd);
    const { profile } = await mutateProfile(
      ctx,
      (profile) => {
        ensureInitialized(profile);
        if (profile.teaching.activeTask) {
          throw new Error("复盘计划前必须先完成或暂停当前教学任务");
        }
        if (new Set(params.currentFocus.map((item) => item.knowledgeId)).size !== params.currentFocus.length) {
          throw new Error("当前主攻节点不能重复");
        }
        if (new Set(params.milestoneUpdates.map((item) => item.id)).size !== params.milestoneUpdates.length) {
          throw new Error("里程碑更新不能重复");
        }
        const selected = new Set(profile.learner.subjects);
        const validateId = (id: string): string => {
          const definition = requireKnowledge(catalog, id);
          if (!selected.has(definition.subject)) throw new Error(`计划节点不属于备考科目：${id}`);
          return definition.id;
        };
        const currentFocus = params.currentFocus.map((focus) => ({
          knowledgeId: validateId(focus.knowledgeId),
          reason: requireNonBlank(focus.reason, `${focus.knowledgeId} 主攻原因`),
        }));
        if (new Set(currentFocus.map((item) => item.knowledgeId)).size !== currentFocus.length) {
          throw new Error("当前主攻节点解析别名后不能重复");
        }
        requireNonBlank(params.reflection, "复盘结论");
        const reviewedSubjects = params.subjectReviews.map((item) => item.subject.trim());
        if (
          new Set(reviewedSubjects).size !== selected.size ||
          reviewedSubjects.some((subject) => !selected.has(subject))
        ) {
          throw new Error(`计划复盘必须恰好覆盖六科：${profile.learner.subjects.join("、")}`);
        }
        params.subjectReviews.forEach((item) => requireNonBlank(item.note, `${item.subject} 复盘结论`));
        const now = nowIso();
        const cycleEnd = new Date(addDays(now, PLAN_CYCLE_DAYS)!);
        const newMilestones = params.newMilestones.map((milestone) => {
          const title = requireNonBlank(milestone.title, "里程碑标题");
          const successCriteria = milestone.successCriteria.map((item) =>
            requireNonBlank(item, "里程碑通过标准"),
          );
          const knowledgeIds = [...new Set(milestone.knowledgeIds.map((id) => validateId(id)))];
          const target = new Date(milestone.targetDate);
          if (Number.isNaN(target.getTime()) || target <= new Date(now)) {
            throw new Error(`新里程碑目标日期必须晚于当前时间：${milestone.targetDate}`);
          }
          if (target > cycleEnd) {
            throw new Error(`新里程碑目标日期不能超过两周周期：${milestone.targetDate}`);
          }
          return { title, successCriteria, knowledgeIds, targetDate: target.toISOString() };
        });

        if (params.reason === "weekly" && profile.plan && !planReviewDue(profile)) {
          throw new Error(`尚未到每周复盘时间：${profile.plan.nextReviewAt}`);
        }

        const input: PlanReviewInput = {
          longTermGoal: params.longTermGoal,
          currentFocus,
          milestoneUpdates: params.milestoneUpdates,
          newMilestones,
          subjectReviews: params.subjectReviews,
          reflection: params.reflection,
        };
        if (!profile.plan) {
          const first = newMilestones[0];
          if (!params.longTermGoal || !first) {
            throw new Error("修复缺失计划时必须提供 longTermGoal 和一个 newMilestone");
          }
          requireNonBlank(params.longTermGoal, "长期目标");
          if (newMilestones.length !== 1) {
            throw new Error("修复缺失计划时只能提交一个首个里程碑");
          }
          profile.plan = createInitialPlan(
            {
              longTermGoal: params.longTermGoal,
              currentFocus,
              milestoneTitle: first.title,
              milestoneKnowledgeIds: first.knowledgeIds,
              milestoneSuccessCriteria: first.successCriteria,
              milestoneTargetDate: first.targetDate,
              subjectReviewNotes: Object.fromEntries(
                params.subjectReviews.map((item) => [item.subject.trim(), item.note.trim()]),
              ),
            },
            now,
          );
          profile.plan.lastReflection = params.reflection.trim();
        } else {
          const existingIds = new Set(profile.plan.milestones.map((item) => item.id));
          for (const update of params.milestoneUpdates) {
            if (!existingIds.has(update.id)) throw new Error(`未知里程碑 ID：${update.id}`);
          }
          if (params.reason === "weekly" || params.reason === "exam") {
            const updatedIds = new Set(params.milestoneUpdates.map((item) => item.id));
            const missingActive = profile.plan.milestones
              .filter((item) => item.status === "active" && !updatedIds.has(item.id))
              .map((item) => item.id);
            if (missingActive.length > 0) {
              throw new Error(`复盘必须更新每个进行中里程碑：${missingActive.join("、")}`);
            }
          }
          for (const update of params.milestoneUpdates) {
            if (update.targetDate) {
              const target = new Date(update.targetDate);
              if (Number.isNaN(target.getTime())) throw new Error(`里程碑日期无效：${update.targetDate}`);
            }
            update.successCriteria?.forEach((item) => requireNonBlank(item, "里程碑通过标准"));
          }
          profile.plan = reviewPlan(profile.plan, input, now);
          for (const milestone of profile.plan.milestones.filter((item) => item.status === "active")) {
            const target = new Date(milestone.targetDate);
            if (target <= new Date(now) || target > new Date(profile.plan.cycleEnd)) {
              throw new Error(`进行中里程碑必须落在新两周周期内：${milestone.id}`);
            }
          }
        }
        profile.sessions.push({
          date: now,
          mode: "plan-review",
          outcome: params.reflection.trim(),
        });
      },
      true,
    );

    return {
      content: [{ type: "text", text: `学习计划已更新到版本 ${profile.plan?.revision}，并同步到 学习计划.md。` }],
      details: { plan: profile.plan },
    };
  },
});

const logSessionTool = defineTool({
  name: "coach_log_session",
  label: "Coach: Log Session",
  description:
    "记录学习结果、用时、学员主动报告的 feeling 和下次起点。不得推断 feeling。活动任务未结束时必须保留 nextStart。",
  parameters: Type.Object({
    mode: StringEnum(SESSION_MODES),
    subject: Type.Optional(Type.String()),
    topic: Type.Optional(Type.String()),
    durationMin: Type.Optional(Type.Number({ minimum: 0 })),
    outcome: Type.Optional(Type.String()),
    feeling: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
    nextStart: Type.Optional(Type.String()),
  }),
  async execute(_callId, params, _signal, _onUpdate, ctx) {
    const { profile, value } = await mutateProfile(ctx, (profile) => {
      if (profile.teaching.activeTask && !params.nextStart?.trim()) {
        throw new Error("仍有活动任务。结束会话前必须记录 nextStart，或先完成、暂停任务。");
      }
      profile.sessions.push({
        date: nowIso(),
        mode: params.mode as SessionMode,
        subject: params.subject?.trim() || undefined,
        topic: params.topic?.trim() || undefined,
        durationMin: params.durationMin,
        outcome: params.outcome?.trim() || undefined,
        feeling: params.feeling,
        nextStart: params.nextStart?.trim() || undefined,
      });
      if (profile.teaching.activeTask && params.nextStart?.trim()) {
        profile.teaching.activeTask.nextStart = params.nextStart.trim();
      }
      return recentFeelingPolicy(profile);
    });

    return {
      content: [
        {
          type: "text",
          text: `已记录本次学习。累计 ${profile.sessions.length} 条记录。节奏：${value.rule}`,
        },
      ],
      details: { count: profile.sessions.length, pacing: value },
    };
  },
});

const dueReviewsTool = defineTool({
  name: "coach_due_reviews",
  label: "Coach: Due Reviews",
  description:
    "按当前主攻、到期时间列出复习节点。开场必须调用。根据当天时长选择数量，不得让到期队列挤掉全部新学习。",
  parameters: Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  }),
  async execute(_callId, params, _signal, _onUpdate, ctx) {
    const profile = readState(ctx);
    const allDue = dueNodes(profile);
    const due = params.limit ? allDue.slice(0, params.limit) : allDue;
    const lines = due.map(
      (node) =>
        `- [${node.subject}] ${node.name} · ${node.state} · 间隔通过 ${node.spacedPasses}/${REQUIRED_SPACED_PASSES} · 到期 ${node.nextReview?.slice(0, 10)}`,
    );
    const planMessage = planReviewDue(profile) ? "\n学习计划也已到复盘时间。" : "";
    const text = due.length
      ? `到期复习 ${allDue.length} 项，本次返回 ${due.length} 项：\n${lines.join("\n")}${planMessage}`
      : `今天没有到期复习。${planMessage}`;
    return {
      content: [{ type: "text", text }],
      details: { due, totalDue: allDue.length, planReviewDue: planReviewDue(profile) },
    };
  },
});

const searchKnowledgeTool = defineTool({
  name: "coach_search_knowledge",
  label: "Coach: Search Knowledge",
  description:
    "只读检索知识节点目录，返回精简节点列表（id、subject、module、name）。knowledgeId 是命名空间式规范 ID（subject::module::name）。初始化前确定 initialFocus 与 milestoneKnowledgeIds 的合法 ID 时必须先用它查到规范 ID，不得猜测。也可按科目浏览可用节点。",
  parameters: Type.Object({
    subject: Type.Optional(
      Type.String({ minLength: 1, description: "按科目精确过滤，如 数学、物理" }),
    ),
    module: Type.Optional(Type.String({ minLength: 1, description: "按模块名包含匹配" })),
    keyword: Type.Optional(
      Type.String({ minLength: 1, description: "按节点名或模块名包含匹配，如 集合" }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "返回上限，默认 50" })),
  }),
  async execute(_callId, params, _signal, _onUpdate, ctx) {
    const catalog = loadCatalog(ctx.cwd);
    const subject = params.subject?.trim() || undefined;
    const moduleQuery = params.module?.trim() || undefined;
    const keyword = params.keyword?.trim() || undefined;
    const limit = Math.min(params.limit ?? 50, 100);
    let nodes = catalog.nodes;
    if (subject) nodes = nodes.filter((node) => node.subject === subject);
    if (moduleQuery) nodes = nodes.filter((node) => node.module.includes(moduleQuery));
    if (keyword) {
      nodes = nodes.filter((node) => node.name.includes(keyword) || node.module.includes(keyword));
    }
    const total = nodes.length;
    const items = nodes.slice(0, limit).map((node) => ({
      id: node.id,
      subject: node.subject,
      module: node.module,
      name: node.name,
    }));
    const subjects = [...new Set(catalog.nodes.map((node) => node.subject))];
    return {
      content: [
        {
          type: "text",
          text: boundedJson({
            subjects,
            query: { subject: subject ?? null, module: moduleQuery ?? null, keyword: keyword ?? null },
            total,
            returned: items.length,
            limit,
            nodes: items,
          }),
        },
      ],
      details: { total, returned: items.length, nodes: items },
    };
  },
});

export default function coachExtension(pi: ExtensionAPI): void {
  pi.registerTool(getStateTool);
  pi.registerTool(completeInitTool);
  pi.registerTool(startTaskTool);
  pi.registerTool(recordTurnTool);
  pi.registerTool(transitionTool);
  pi.registerTool(recordVerificationTool);
  pi.registerTool(recordReviewTool);
  pi.registerTool(auditTurnTool);
  pi.registerTool(auditReviewTool);
  pi.registerTool(updatePlanTool);
  pi.registerTool(logSessionTool);
  pi.registerTool(dueReviewsTool);
  pi.registerTool(searchKnowledgeTool);

  pi.on("session_start", async (_event, ctx) => {
    let profile: Profile;
    try {
      profile = readState(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`学习教员状态读取失败：${message}`, "error");
      return;
    }
    refreshWidget(ctx, profile);
    if (!profile.initialized) {
      ctx.ui.notify("学习教员：尚未初始化，输入 /coach 开始初始化引导", "info");
      return;
    }
    const due = dueNodes(profile);
    if (due.length > 0) ctx.ui.notify(`今天有 ${due.length} 项到期复习`, "info");
    if (planReviewDue(profile)) ctx.ui.notify("学习计划已到复盘时间", "info");
  });

  pi.registerCommand("coach-status", {
    description: "显示学习教员状态摘要",
    handler: async (_args, ctx) => {
      let profile: Profile;
      try {
        profile = readState(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`学习教员状态读取失败：${message}`, "error");
        return;
      }
      const due = dueNodes(profile);
      const active = profile.teaching.activeTask?.knowledgeId ?? "无活动任务";
      const mastered = Object.values(profile.knowledge).filter((node) => node.state === "mastered").length;
      ctx.ui.notify(
        profile.initialized
          ? `${profile.learner.name} | 到期 ${due.length} | 已掌握 ${mastered} | 当前 ${active}`
          : "学习教员尚未初始化",
        "info",
      );
    },
  });
}

export { DEFAULT_PROFILE };
