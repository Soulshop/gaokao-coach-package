import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalKnowledgeId, requireKnowledge, validateCatalog } from "../extensions/coach/catalog.ts";
import { createInitialPlan, renderStudyPlan, reviewPlan } from "../extensions/coach/plan.ts";
import { addDays, isDue, sm2 } from "../extensions/coach/scheduler.ts";
import {
  allVerificationPassed,
  applyTurn,
  canFinishLocally,
  computeExplanationEligibility,
  computeReadiness,
  createActiveTask,
  createExplanation,
  recordVerificationStatus,
  reviewQuality,
  type TurnInput,
} from "../extensions/coach/teaching.ts";
import {
  appendAuditRecord,
  auditStats,
  differingDimensions,
  missingArbitrations,
  readAuditLog,
  type AuditRecord,
} from "../extensions/coach/audit.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFileSync } from "node:fs";

const NOW = "2026-01-01T00:00:00.000Z";

function task() {
  return createActiveTask({
    id: "task-1",
    knowledgeId: "数学::函数::输入对应输出",
    mode: "teach",
    goal: "判断一个对应是否为函数",
    problemMap: {
      goal: "判断对应是否为函数",
      known: "给出输入与输出对应",
      missing: "是否满足函数关系",
      concept: "输入对应输出",
      relation: "每个输入只能有一个确定输出",
    },
    now: NOW,
  });
}

function turn(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    questionKey: "q-default",
    questionRole: "core",
    guidanceMethod: "none",
    supportDepth: 0,
    attemptDepth: "generative",
    progress: "new",
    emotionalSignal: false,
    refused: false,
    correct: true,
    independent: true,
    evidenceKinds: ["relate", "reason"],
    overviewItems: [],
    coreError: false,
    ...overrides,
  };
}

test("生成性错误能同时增加有效尝试和无进展", () => {
  const current = task();
  applyTurn(
    current,
    turn({
      questionKey: "wrong-reason",
      progress: "none",
      correct: false,
      evidenceKinds: ["reason", "error"],
    }),
    NOW,
    "turn-1",
  );
  assert.equal(current.effectiveAttempts, 1);
  assert.equal(current.noProgressStreak, 1);

  applyTurn(
    current,
    turn({
      questionKey: "locate",
      guidanceMethod: "locate",
      supportDepth: 1,
      attemptDepth: "recognition",
      evidenceKinds: [],
    }),
    NOW,
    "turn-2",
  );
  assert.equal(current.microProgress, 1);
  assert.equal(current.noProgressStreak, 0);
});

test("错误回答和拒绝回答不能伪造进展或正确性", () => {
  const current = task();
  assert.throws(
    () =>
      applyTurn(
        current,
        turn({ questionKey: "wrong-new", correct: false, progress: "new" }),
        NOW,
        "turn-1",
      ),
    /新增进展必须来自正确/,
  );
  assert.throws(
    () =>
      applyTurn(
        current,
        turn({
          questionKey: "refused-correct",
          attemptDepth: "none",
          progress: "none",
          refused: true,
          correct: true,
          independent: false,
          evidenceKinds: [],
        }),
        NOW,
        "turn-2",
      ),
    /正确性和独立性必须为否/,
  );
});

test("连续不会按 2、3、4 轮返回确定动作", () => {
  const current = task();
  const expected = [
    "locate-difficulty",
    "increase-support",
    "offer-limited-choice",
    "diagnose-prerequisite-or-pause",
  ];
  const methods = ["none", "locate", "smaller-question", "limited-choice"] as const;
  const depths = [0, 1, 2, 2];
  for (let index = 0; index < 4; index++) {
    applyTurn(
      current,
      turn({
        questionKey: `unknown-${index}`,
        guidanceMethod: methods[index],
        supportDepth: depths[index],
        attemptDepth: "none",
        progress: "none",
        correct: false,
        independent: false,
        evidenceKinds: [],
      }),
      NOW,
      `turn-${index}`,
    );
    assert.equal(current.nextAction, expected[index]);
  }
});

test("连续两轮拒绝优先触发情绪暂停", () => {
  const current = task();
  for (let index = 0; index < 2; index++) {
    applyTurn(
      current,
      turn({
        questionKey: `refuse-${index}`,
        guidanceMethod: index === 0 ? "none" : "locate",
        supportDepth: index,
        attemptDepth: "none",
        progress: "none",
        refused: true,
        correct: false,
        independent: false,
        evidenceKinds: [],
      }),
      NOW,
      `turn-${index}`,
    );
  }
  assert.equal(current.nextAction, "pause-for-emotion");
});

test("同一逻辑问题最多记录两次，且第二次必须改变操作", () => {
  const current = task();
  const noProgress = (overrides) =>
    turn({
      questionKey: "same",
      attemptDepth: "none",
      progress: "none",
      correct: false,
      independent: false,
      evidenceKinds: [],
      ...overrides,
    });
  applyTurn(current, noProgress({ guidanceMethod: "none", supportDepth: 0 }), NOW, "turn-1");
  applyTurn(
    current,
    noProgress({ guidanceMethod: "locate", supportDepth: 1 }),
    NOW,
    "turn-2",
  );
  assert.throws(
    () =>
      applyTurn(
        current,
        noProgress({ guidanceMethod: "locate", supportDepth: 1 }),
        NOW,
        "turn-3",
      ),
    /必须改变引导方法或支持深度/,
  );
  assert.throws(
    () =>
      applyTurn(
        current,
        noProgress({ guidanceMethod: "smaller-question", supportDepth: 2 }),
        NOW,
        "turn-4",
      ),
    /不得使用超过两次/,
  );
});

test("微进展不能建立准备度或问题全貌", () => {
  const current = task();
  applyTurn(
    current,
    turn({
      questionKey: "recognition-only",
      attemptDepth: "recognition",
      evidenceKinds: [],
      overviewItems: ["goal", "known", "missing", "concept", "relation"],
    }),
    NOW,
    "turn-1",
  );
  assert.equal(computeReadiness(current).ready, false);
  assert.equal(current.overview.goal, false);
  assert.throws(
    () =>
      applyTurn(
        current,
        turn({
          questionKey: "recognition-with-evidence",
          attemptDepth: "recognition",
          evidenceKinds: ["define"],
        }),
        NOW,
        "turn-2",
      ),
    /微进展不能携带/,
  );
});

test("当前准备度不等于长期掌握", () => {
  const current = task();
  applyTurn(
    current,
    turn({ questionKey: "define", evidenceKinds: ["define"], overviewItems: ["concept"] }),
    NOW,
    "turn-1",
  );
  applyTurn(
    current,
    turn({ questionKey: "relate", evidenceKinds: ["relate", "reason"], overviewItems: ["goal", "known"] }),
    NOW,
    "turn-2",
  );
  assert.equal(computeReadiness(current).ready, true);
  assert.equal(canFinishLocally(current).allowed, false);

  applyTurn(
    current,
    turn({ questionKey: "transfer", evidenceKinds: ["near-transfer"] }),
    NOW,
    "turn-3",
  );
  assert.equal(canFinishLocally(current).allowed, true);
});

test("组 A 只在共同条件和连接失败都满足时开放", () => {
  const current = task();
  const inputs: TurnInput[] = [
    turn({
      questionKey: "sub-1",
      questionRole: "key-subproblem",
      guidanceMethod: "smaller-question",
      supportDepth: 0,
      evidenceKinds: ["define", "purpose"],
      overviewItems: ["goal", "known", "concept"],
    }),
    turn({
      questionKey: "sub-2",
      questionRole: "key-subproblem",
      guidanceMethod: "split",
      supportDepth: 0,
      evidenceKinds: ["relate"],
      overviewItems: ["relation"],
    }),
    turn({
      questionKey: "sub-3",
      questionRole: "key-subproblem",
      guidanceMethod: "limited-choice",
      supportDepth: 0,
      progress: "none",
      correct: false,
      evidenceKinds: ["error"],
    }),
    turn({
      questionKey: "connect-1",
      questionRole: "connection",
      guidanceMethod: "locate",
      supportDepth: 1,
      progress: "none",
      correct: false,
      evidenceKinds: ["error"],
      blockedRelation: "每个输入只能有一个确定输出",
    }),
    turn({
      questionKey: "connect-2",
      questionRole: "connection",
      guidanceMethod: "reconstruct",
      supportDepth: 2,
      progress: "none",
      correct: false,
      evidenceKinds: ["error"],
      blockedRelation: "每个输入只能有一个确定输出",
    }),
  ];
  inputs.forEach((input, index) => applyTurn(current, input, NOW, `turn-${index}`));
  const eligibility = computeExplanationEligibility(current, current.problemMap.relation);
  assert.equal(eligibility.globalReady, true);
  assert.equal(eligibility.groups.A, true);
  assert.equal(current.nextAction, "request-explanation");
  assert.equal(computeExplanationEligibility(current, "另一条关系").groups.A, false);
});

test("blockedRelation 只在无进展的连接轮或路径轮必填", () => {
  const current = task();
  applyTurn(
    current,
    turn({ questionKey: "intro-link", questionRole: "connection" }),
    NOW,
    "t-1",
  );
  applyTurn(current, turn({ questionKey: "path-ok", pathId: "p1" }), NOW, "t-2");
  assert.throws(
    () =>
      applyTurn(
        current,
        turn({
          questionKey: "connect-fail",
          questionRole: "connection",
          progress: "none",
          correct: false,
          evidenceKinds: ["error"],
        }),
        NOW,
        "t-3",
      ),
    /blockedRelation/,
  );
  assert.throws(
    () =>
      applyTurn(
        current,
        turn({
          questionKey: "path-fail",
          pathId: "p1",
          progress: "none",
          correct: false,
          evidenceKinds: ["error"],
        }),
        NOW,
        "t-4",
      ),
    /blockedRelation/,
  );
  assert.equal(current.rounds, 2);
});

test("讲解资格回显已登记的 blockedRelation", () => {
  const current = task();
  applyTurn(
    current,
    turn({
      questionKey: "c1",
      questionRole: "connection",
      progress: "none",
      correct: false,
      evidenceKinds: ["error"],
      blockedRelation: "  每个输入只能有一个确定输出  ",
    }),
    NOW,
    "t-1",
  );
  applyTurn(
    current,
    turn({
      questionKey: "c2",
      guidanceMethod: "locate",
      supportDepth: 1,
      progress: "new",
      blockedRelation: "不该被收录的值",
    }),
    NOW,
    "t-2",
  );
  const eligibility = computeExplanationEligibility(current, "每个输入只能有一个确定输出");
  assert.deepEqual(eligibility.facts.recordedBlockedRelations, ["每个输入只能有一个确定输出"]);
});

test("五步验证不能跳步，也不能靠失败前进", () => {
  const explanation = createExplanation("A", "关键关系", NOW);
  assert.throws(() => recordVerificationStatus(explanation, "reason", true, NOW), /必须按序/);

  recordVerificationStatus(explanation, "restate", false, NOW);
  assert.equal(explanation.nextStep, "restate");
  recordVerificationStatus(explanation, "restate", true, NOW);
  recordVerificationStatus(explanation, "reason", true, NOW);
  recordVerificationStatus(explanation, "near-transfer", true, NOW);
  recordVerificationStatus(explanation, "counterexample", true, NOW);
  recordVerificationStatus(explanation, "return", true, NOW);
  assert.equal(allVerificationPassed(explanation), true);
  assert.throws(() => recordVerificationStatus(explanation, "return", true, NOW), /已经完成/);
});

test("只有完整复习才得到满分调度结果", () => {
  assert.deepEqual(
    reviewQuality({
      independent: true,
      retrievalCorrect: true,
      reasonPassed: true,
      transferPassed: true,
      boundaryPassed: true,
    }),
    { quality: 5, fullPass: true },
  );
  assert.deepEqual(
    reviewQuality({
      independent: true,
      retrievalCorrect: true,
      reasonPassed: true,
      transferPassed: false,
      boundaryPassed: true,
    }),
    { quality: 2, fullPass: false },
  );
});

test("SM-2 只按独立复习事件推进", () => {
  let state = { quality: 5, ease: 2.5, intervalDays: 0, repetitions: 0 };
  const first = sm2(state);
  const second = sm2({ quality: 5, ...first });
  const third = sm2({ quality: 5, ...second });
  assert.equal(first.intervalDays, 1);
  assert.equal(second.intervalDays, 6);
  assert.equal(third.intervalDays, 17);
  assert.equal(addDays(NOW, 1), "2026-01-02T00:00:00.000Z");
  assert.equal(isDue("2025-12-31T00:00:00.000Z", new Date(NOW)), true);
});

test("知识目录 ID、前置边和无环约束通过", () => {
  const raw = JSON.parse(readFileSync(new URL("../templates/知识节点.json", import.meta.url), "utf8"));
  const catalog = validateCatalog(raw);
  assert.ok(catalog.nodes.length >= 20);
  assert.ok(catalog.nodes.some((node) => node.id === "数学::函数::输入对应输出"));
});

test("知识目录别名解析到正式 ID", () => {
  const catalog = validateCatalog({
    version: 1,
    scope: "test",
    aliases: { "数学::旧模块::旧名": "数学::模块::新名" },
    nodes: [
      {
        id: "数学::模块::新名",
        subject: "数学",
        module: "模块",
        name: "新名",
        prerequisites: [],
        successCriteria: ["能验证"],
      },
    ],
  });
  assert.equal(canonicalKnowledgeId(catalog, "数学::旧模块::旧名"), "数学::模块::新名");
  assert.equal(requireKnowledge(catalog, "数学::旧模块::旧名").id, "数学::模块::新名");
});

test("评分审计逐维比较且证据类型按集合比较", () => {
  const base = {
    correct: true,
    attemptDepth: "generative" as const,
    progress: "new" as const,
    independent: true,
    evidenceKinds: ["reason", "relate"] as const,
  };
  assert.deepEqual(differingDimensions("turn-sample", { ...base }, { ...base }), []);
  assert.deepEqual(
    differingDimensions(
      "turn-sample",
      { ...base, evidenceKinds: ["relate", "reason"] },
      { ...base, evidenceKinds: ["reason", "relate"] },
    ),
    [],
  );
  assert.deepEqual(
    differingDimensions("turn-sample", { ...base }, { ...base, correct: false, evidenceKinds: ["error"] }),
    ["correct", "evidenceKinds"],
  );
  assert.deepEqual(
    differingDimensions(
      "review",
      { independent: true, retrievalCorrect: true, reasonPassed: true, transferPassed: true, boundaryPassed: true },
      { independent: true, retrievalCorrect: true, reasonPassed: false, transferPassed: true, boundaryPassed: false },
    ),
    ["reasonPassed", "boundaryPassed"],
  );
});

test("仲裁必须恰好覆盖分歧维度", () => {
  const differing = ["correct", "evidenceKinds"];
  assert.deepEqual(missingArbitrations(differing, []), differing);
  assert.deepEqual(
    missingArbitrations(differing, [
      { dimension: "correct", decision: "auditor", evidenceQuote: "学员原话" },
      { dimension: "evidenceKinds", decision: "coach", evidenceQuote: "学员原话" },
    ]),
    [],
  );
});

test("审计日志只追加、容忍损坏行并统计一致率", () => {
  const cwd = mkdtempSync(join(tmpdir(), "coach-audit-"));
  try {
    const record = (id: string, agreed: boolean): AuditRecord => ({
      id,
      date: "2026-01-01T00:00:00.000Z",
      kind: "turn-sample",
      taskId: "task-1",
      knowledgeId: "数学::函数::输入对应输出",
      questionRef: "q1",
      coach: { correct: true, attemptDepth: "generative", progress: "new", independent: true, evidenceKinds: ["reason"] },
      auditor: { correct: true, attemptDepth: "generative", progress: "new", independent: true, evidenceKinds: ["reason"] },
      arbitrations: [],
      agreed,
    });
    appendAuditRecord(cwd, record("audit-1", true));
    appendAuditRecord(cwd, record("audit-2", false));
    appendFileSync(join(cwd, ".pi", "state", "grading-audit.jsonl"), "{损坏行\n");

    const records = readAuditLog(cwd);
    assert.equal(records.length, 2);
    const stats = auditStats(records);
    assert.equal(stats.total, 2);
    assert.equal(stats.agreed, 1);
    assert.equal(stats.disagreements, 1);
    assert.equal(stats.agreementRate, 0.5);
    assert.equal(stats.byKind["turn-sample"].total, 2);
    assert.equal(stats.byKind.review.total, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("两周计划生成学员视图并在复盘后滚动", () => {
  const plan = createInitialPlan(
    {
      longTermGoal: "建立六科稳定基础",
      currentFocus: [{ knowledgeId: "数学::函数::输入对应输出", reason: "当前基础断点" }],
      milestoneTitle: "完成函数入口",
      milestoneKnowledgeIds: ["数学::函数::输入对应输出"],
      milestoneSuccessCriteria: ["能说明输入与输出关系"],
      subjectReviewNotes: { 语文: "待检查", 数学: "当前主攻", 英语: "待检查", 物理: "待检查", 化学: "待检查", 生物: "待检查" },
    },
    NOW,
  );
  assert.equal(plan.nextReviewAt, "2026-01-08T00:00:00.000Z");
  assert.match(renderStudyPlan(plan, 60, "晚上"), /每 7 天/);

  const reviewed = reviewPlan(
    plan,
    {
      currentFocus: plan.currentFocus,
      milestoneUpdates: [{ id: plan.milestones[0].id, status: "done" }],
      newMilestones: [],
      subjectReviews: [
        { subject: "语文", note: "待检查" },
        { subject: "数学", note: "函数入口通过" },
        { subject: "英语", note: "待检查" },
        { subject: "物理", note: "待检查" },
        { subject: "化学", note: "待检查" },
        { subject: "生物", note: "待检查" },
      ],
      reflection: "函数入口通过",
    },
    "2026-01-08T00:00:00.000Z",
  );
  assert.equal(reviewed.revision, 2);
  assert.equal(reviewed.milestones[0].status, "done");
  assert.equal(reviewed.nextReviewAt, "2026-01-15T00:00:00.000Z");
});
