import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";

const ROOT = process.cwd();
const piBinary = execFileSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" }).trim();
const piRoot = dirname(dirname(realpathSync(piBinary)));
const loaderUrl = pathToFileURL(join(piRoot, "dist", "core", "extensions", "loader.js")).href;
const { loadExtensions } = await import(loaderUrl);
const loaded = await loadExtensions([join(ROOT, "extensions", "coach", "index.ts")], ROOT);
if (loaded.errors.length > 0) throw new Error(JSON.stringify(loaded.errors));
const tools = new Map([...loaded.extensions[0].tools].map(([name, item]) => [name, item.definition]));

const SUBJECTS = ["语文", "数学", "英语", "物理", "化学", "生物"];

function createHarness(initialFocus) {
  const cwd = mkdtempSync(join(tmpdir(), "coach-flow-"));
  mkdirSync(join(cwd, "学习资料"), { recursive: true });
  cpSync(join(ROOT, "templates", "知识节点.json"), join(cwd, "学习资料", "知识节点.json"));
  const ctx = { cwd, hasUI: false, mode: "print", ui: {} };
  const run = (name, params) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool.execute(`call-${name}`, params, undefined, undefined, ctx);
  };
  const initialize = () =>
    run("coach_complete_init", {
      name: "测试学员",
      firstElective: "物理",
      secondElectives: ["化学", "生物"],
      dailyMinutes: 60,
      preferredTime: "晚上",
      baselineBySubject: SUBJECTS.map((subject) => ({
        subject,
        note: "待课堂证据校准",
        source: "self-report",
      })),
      schoolProgressBySubject: SUBJECTS.map((subject) => ({ subject, note: "高一当前进度" })),
      longTermGoal: "建立广东高考六科基础",
      initialFocus: [{ knowledgeId: initialFocus, reason: "当前启动节点" }],
      milestoneTitle: "完成启动节点",
      milestoneKnowledgeIds: [initialFocus],
      milestoneSuccessCriteria: ["能独立说明关系并完成近迁移"],
    });
  return {
    cwd,
    run,
    initialize,
    readProfile: () => JSON.parse(readFileSync(join(cwd, ".pi", "state", "profile.json"), "utf8")),
    writeProfile: (profile) =>
      writeFileSync(join(cwd, ".pi", "state", "profile.json"), JSON.stringify(profile, null, 2) + "\n"),
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

async function auditReview(run, taskId) {
  const labels = {
    independent: true,
    retrievalCorrect: true,
    reasonPassed: true,
    transferPassed: true,
    boundaryPassed: true,
  };
  const result = await run("coach_audit_review", {
    taskId,
    coachLabels: labels,
    auditorLabels: labels,
    arbitrations: [],
  });
  return result.details.audit.id;
}

function problemMap(relation) {
  return {
    goal: "判断关系是否成立",
    known: "题目给出条件",
    missing: "还需判断的关系",
    concept: "当前核心概念",
    relation,
  };
}

async function recordTurn(run, taskId, input) {
  return run("coach_record_turn", {
    taskId,
    questionKey: input.questionKey,
    questionRole: input.questionRole ?? "core",
    guidanceMethod: input.guidanceMethod ?? "none",
    supportDepth: input.supportDepth ?? 0,
    attemptDepth: input.attemptDepth ?? "generative",
    progress: input.progress ?? "new",
    emotionalSignal: input.emotionalSignal ?? false,
    refused: input.refused ?? false,
    correct: input.correct ?? true,
    independent: input.independent ?? true,
    evidenceKinds: input.evidenceKinds ?? [],
    overviewItems: input.overviewItems ?? [],
    coreError: input.coreError ?? false,
    pathId: input.pathId,
    blockedRelation: input.blockedRelation,
    candidatePrerequisiteId: input.candidatePrerequisiteId,
  });
}

test("前置阻塞需要两个目录内诊断，并在前置验证后恢复原任务", async () => {
  const targetId = "数学::函数::定义域";
  const prerequisiteId = "数学::初高衔接::分式的意义与限制条件";
  const harness = createHarness(targetId);
  try {
    await harness.initialize();
    const started = await harness.run("coach_start_task", {
      knowledgeId: targetId,
      mode: "teach",
      goal: "判断定义域限制",
      problemMap: problemMap("限制条件来自表达式有意义"),
    });
    const parentTaskId = started.details.task.id;

    for (let index = 0; index < 4; index++) {
      await recordTurn(harness.run, parentTaskId, {
        questionKey: `stuck-${index}`,
        guidanceMethod:
          index === 1 ? "locate" : index === 2 ? "smaller-question" : index === 3 ? "limited-choice" : "none",
        supportDepth: [0, 1, 2, 2][index],
        attemptDepth: "none",
        progress: "none",
        correct: false,
        independent: false,
      });
    }
    for (let index = 0; index < 2; index++) {
      await recordTurn(harness.run, parentTaskId, {
        questionKey: `prerequisite-probe-${index}`,
        questionRole: "prerequisite-diagnostic",
        attemptDepth: "none",
        progress: "none",
        correct: false,
        independent: false,
        candidatePrerequisiteId: prerequisiteId,
      });
    }

    await harness.run("coach_transition", {
      taskId: parentTaskId,
      action: "block-for-prerequisite",
      prerequisiteId,
      nextStart: "回到定义域限制来源",
    });
    let profile = harness.readProfile();
    assert.equal(profile.knowledge[targetId].state, "blocked");
    assert.equal(profile.teaching.pausedTasks[0].blockedBy, prerequisiteId);

    const child = await harness.run("coach_start_task", {
      knowledgeId: prerequisiteId,
      mode: "teach",
      goal: "说明分式限制条件",
      problemMap: problemMap("分母不能为零"),
    });
    const childTaskId = child.details.task.id;
    assert.equal(child.details.task.parentTaskId, parentTaskId);

    await recordTurn(harness.run, childTaskId, {
      questionKey: "child-stuck",
      attemptDepth: "none",
      progress: "none",
      correct: false,
      independent: false,
    });
    await harness.run("coach_transition", {
      taskId: childTaskId,
      action: "authorize-explanation",
      gate: "prerequisite",
      keyRelation: "分母为零时分式没有意义",
    });
    await assert.rejects(
      () =>
        harness.run("coach_transition", {
          taskId: childTaskId,
          action: "block-for-prerequisite",
          prerequisiteId: "数学::初高衔接::有理数运算",
          nextStart: "不得跳过验证",
        }),
      /验证期间不能改判/,
    );
    await assert.rejects(
      () =>
        harness.run("coach_record_verification", {
          taskId: childTaskId,
          step: "restate",
          questionKey: "verify-restate-guided",
          passed: true,
          attemptDepth: "generative",
          refused: false,
          independent: false,
          supportDepth: 1,
          guidanceMethod: "precision",
          coreError: false,
        }),
      /独立完成/,
    );
    for (const step of ["restate", "reason", "near-transfer", "counterexample", "return"]) {
      await harness.run("coach_record_verification", {
        taskId: childTaskId,
        step,
        questionKey: `verify-${step}`,
        passed: true,
        attemptDepth: "generative",
        refused: false,
        independent: true,
        supportDepth: 0,
        guidanceMethod: "none",
        coreError: false,
      });
    }
    await harness.run("coach_transition", { taskId: childTaskId, action: "finish-verified" });

    profile = harness.readProfile();
    assert.equal(profile.teaching.activeTask.id, parentTaskId);
    assert.equal(profile.teaching.activeTask.noProgressStreak, 0);
    assert.equal(profile.knowledge[targetId].state, "learning");
    assert.equal(profile.knowledge[targetId].blockedBy, undefined);
    assert.equal(profile.knowledge[prerequisiteId].localVerification.method, "explained");
    assert.equal(profile.teaching.completedTasks.length, 1);
  } finally {
    harness.cleanup();
  }
});

test("长期掌握只在三个独立到期复习任务后产生", async () => {
  const knowledgeId = "数学::函数::输入对应输出";
  const harness = createHarness(knowledgeId);
  try {
    await harness.initialize();
    let started = await harness.run("coach_start_task", {
      knowledgeId,
      mode: "teach",
      goal: "判断输入输出关系",
      problemMap: problemMap("每个输入只有一个确定输出"),
    });
    let taskId = started.details.task.id;
    await recordTurn(harness.run, taskId, {
      questionKey: "define",
      evidenceKinds: ["define", "purpose"],
    });
    await recordTurn(harness.run, taskId, {
      questionKey: "relate",
      evidenceKinds: ["relate", "reason"],
    });
    await recordTurn(harness.run, taskId, {
      questionKey: "near-transfer",
      evidenceKinds: ["near-transfer"],
    });
    await harness.run("coach_transition", { taskId, action: "finish-verified" });

    for (let review = 1; review <= 3; review++) {
      const profile = harness.readProfile();
      profile.knowledge[knowledgeId].nextReview = "2000-01-01T00:00:00.000Z";
      harness.writeProfile(profile);
      started = await harness.run("coach_start_task", {
        knowledgeId,
        mode: "review",
        goal: "间隔复习输入输出关系",
        problemMap: problemMap("每个输入只有一个确定输出"),
      });
      taskId = started.details.task.id;
      await recordTurn(harness.run, taskId, {
        questionKey: `review-${review}-retrieve`,
        evidenceKinds: ["apply"],
      });
      await recordTurn(harness.run, taskId, {
        questionKey: `review-${review}-reason`,
        evidenceKinds: ["reason"],
      });
      await recordTurn(harness.run, taskId, {
        questionKey: `review-${review}-transfer`,
        evidenceKinds: ["near-transfer"],
      });
      await recordTurn(harness.run, taskId, {
        questionKey: `review-${review}-boundary`,
        evidenceKinds: ["boundary"],
      });
      const auditId = await auditReview(harness.run, taskId);
      const result = await harness.run("coach_record_review", { taskId, auditId });
      assert.equal(result.details.spacedPasses, review);
      assert.equal(result.details.state, review === 3 ? "mastered" : "review");
    }

    const final = harness.readProfile();
    assert.equal(final.knowledge[knowledgeId].state, "mastered");
    assert.equal(final.knowledge[knowledgeId].reviews, 3);
    assert.deepEqual(
      final.knowledge[knowledgeId].reviewHistory.map((item) => item.quality),
      [5, 5, 5],
    );
    assert.equal(final.teaching.completedTasks.length, 4);
  } finally {
    harness.cleanup();
  }
});

test("复习工具拒绝无回答和不完整评估", async () => {
  const knowledgeId = "数学::函数::输入对应输出";
  const harness = createHarness(knowledgeId);
  try {
    await harness.initialize();
    let started = await harness.run("coach_start_task", {
      knowledgeId,
      mode: "teach",
      goal: "判断输入输出关系",
      problemMap: problemMap("每个输入只有一个确定输出"),
    });
    let taskId = started.details.task.id;
    await recordTurn(harness.run, taskId, { questionKey: "define", evidenceKinds: ["define"] });
    await recordTurn(harness.run, taskId, {
      questionKey: "relation",
      evidenceKinds: ["relate", "reason"],
    });
    await recordTurn(harness.run, taskId, {
      questionKey: "transfer",
      evidenceKinds: ["near-transfer"],
    });
    await harness.run("coach_transition", { taskId, action: "finish-verified" });

    const profile = harness.readProfile();
    profile.knowledge[knowledgeId].nextReview = "2000-01-01T00:00:00.000Z";
    harness.writeProfile(profile);
    started = await harness.run("coach_start_task", {
      knowledgeId,
      mode: "review",
      goal: "间隔复习",
      problemMap: problemMap("每个输入只有一个确定输出"),
    });
    taskId = started.details.task.id;
    await assert.rejects(() => harness.run("coach_record_review", { taskId }), /尚未记录任何学员回答/);

    await recordTurn(harness.run, taskId, {
      questionKey: "retrieve-only",
      evidenceKinds: ["apply"],
    });
    await assert.rejects(() => harness.run("coach_record_review", { taskId }), /至少四轮独立生成性作答/);

    for (const [key, kinds] of [
      ["reason", ["reason"]],
      ["transfer", ["near-transfer"]],
      ["retrieve-again", ["apply"]],
    ]) {
      await recordTurn(harness.run, taskId, { questionKey: key, evidenceKinds: kinds });
    }
    await assert.rejects(() => harness.run("coach_record_review", { taskId }), /必须携带审计编号/);
    const auditId = await auditReview(harness.run, taskId);
    const result = await harness.run("coach_record_review", { taskId, auditId });
    assert.equal(result.details.fullPass, false);
    assert.equal(result.details.state, "learning");
    assert.equal(result.details.evidence.boundaryPassed, false);
  } finally {
    harness.cleanup();
  }
});

test("教学抽检记录盲评比较、仲裁并拒绝重复", async () => {
  const knowledgeId = "数学::函数::输入对应输出";
  const harness = createHarness(knowledgeId);
  try {
    await harness.initialize();
    const started = await harness.run("coach_start_task", {
      knowledgeId,
      mode: "teach",
      goal: "判断输入输出关系",
      problemMap: problemMap("每个输入只有一个确定输出"),
    });
    const taskId = started.details.task.id;
    await recordTurn(harness.run, taskId, { questionKey: "define", evidenceKinds: ["define"] });
    await recordTurn(harness.run, taskId, { questionKey: "relate", evidenceKinds: ["relate"] });
    await recordTurn(harness.run, taskId, { questionKey: "reason", evidenceKinds: ["reason"] });

    const coachLabels = {
      correct: true,
      attemptDepth: "generative",
      progress: "new",
      independent: true,
      evidenceKinds: ["reason"],
    };

    const agreed = await harness.run("coach_audit_turn", {
      taskId,
      questionRef: "reason",
      coachLabels,
      auditorLabels: coachLabels,
      arbitrations: [],
    });
    assert.equal(agreed.details.audit.agreed, true);

    await assert.rejects(
      () =>
        harness.run("coach_audit_turn", {
          taskId,
          questionRef: "reason",
          coachLabels,
          auditorLabels: coachLabels,
          arbitrations: [],
        }),
      /已复评/,
    );

    const disputedLabels = { ...coachLabels, correct: false, progress: "none", evidenceKinds: [] };
    await assert.rejects(
      () =>
        harness.run("coach_audit_turn", {
          taskId,
          questionRef: "define",
          coachLabels,
          auditorLabels: disputedLabels,
          arbitrations: [],
        }),
      /仲裁缺失维度：correct、progress、evidenceKinds/,
    );

    await assert.rejects(
      () =>
        harness.run("coach_audit_turn", {
          taskId,
          questionRef: "define",
          coachLabels,
          auditorLabels: disputedLabels,
          arbitrations: [
            { dimension: "correct", decision: "auditor", evidenceQuote: "学员原话：定义写反了" },
            { dimension: "progress", decision: "auditor", evidenceQuote: "学员原话：没有新增" },
            { dimension: "independent", decision: "coach", evidenceQuote: "学员原话：独立完成" },
            { dimension: "evidenceKinds", decision: "auditor", evidenceQuote: "学员原话：未给出理由" },
          ],
        }),
      /不需要仲裁/,
    );

    const disputed = await harness.run("coach_audit_turn", {
      taskId,
      questionRef: "define",
      coachLabels,
      auditorLabels: disputedLabels,
      arbitrations: [
        { dimension: "correct", decision: "auditor", evidenceQuote: "学员原话：定义写反了" },
        { dimension: "progress", decision: "coach", evidenceQuote: "学员原话：定位了卡点" },
        { dimension: "evidenceKinds", decision: "auditor", evidenceQuote: "学员原话：未给出理由" },
      ],
    });
    assert.equal(disputed.details.audit.agreed, false);
    assert.equal(disputed.details.stats.total, 2);
    assert.equal(disputed.details.stats.agreed, 1);

    const lines = readFileSync(join(harness.cwd, ".pi", "state", "grading-audit.jsonl"), "utf8")
      .trim()
      .split("\n");
    assert.equal(lines.length, 2);

    const state = await harness.run("coach_get_state", {});
    assert.equal(state.details.summary.gradingAudit.total, 2);
    assert.equal(state.details.summary.gradingAudit.agreed, 1);
  } finally {
    harness.cleanup();
  }
});

test("复习计分必须携带本任务的复评审计编号", async () => {
  const knowledgeId = "数学::函数::输入对应输出";
  const harness = createHarness(knowledgeId);
  try {
    await harness.initialize();
    let started = await harness.run("coach_start_task", {
      knowledgeId,
      mode: "teach",
      goal: "判断输入输出关系",
      problemMap: problemMap("每个输入只有一个确定输出"),
    });
    let taskId = started.details.task.id;
    await recordTurn(harness.run, taskId, { questionKey: "define", evidenceKinds: ["define"] });
    await recordTurn(harness.run, taskId, { questionKey: "relate", evidenceKinds: ["relate", "reason"] });
    await recordTurn(harness.run, taskId, { questionKey: "near-transfer", evidenceKinds: ["near-transfer"] });
    await harness.run("coach_transition", { taskId, action: "finish-verified" });

    const profile = harness.readProfile();
    profile.knowledge[knowledgeId].nextReview = "2000-01-01T00:00:00.000Z";
    harness.writeProfile(profile);
    started = await harness.run("coach_start_task", {
      knowledgeId,
      mode: "review",
      goal: "间隔复习输入输出关系",
      problemMap: problemMap("每个输入只有一个确定输出"),
    });
    taskId = started.details.task.id;

    await assert.rejects(() => auditReview(harness.run, taskId), /先完成全部复习回合/);

    await recordTurn(harness.run, taskId, { questionKey: "retrieve", evidenceKinds: ["apply"] });
    await recordTurn(harness.run, taskId, { questionKey: "reason", evidenceKinds: ["reason"] });
    await recordTurn(harness.run, taskId, { questionKey: "transfer", evidenceKinds: ["near-transfer"] });
    await recordTurn(harness.run, taskId, { questionKey: "boundary", evidenceKinds: ["boundary"] });

    await assert.rejects(
      () => harness.run("coach_record_review", { taskId, auditId: "audit-伪造" }),
      /审计编号不存在/,
    );

    const auditId = await auditReview(harness.run, taskId);
    await assert.rejects(() => auditReview(harness.run, taskId), /覆盖最新回合/);

    // 补问新回合后允许复审并拿到新编号
    await recordTurn(harness.run, taskId, { questionKey: "boundary-2", evidenceKinds: ["boundary"] });
    const secondAuditId = await auditReview(harness.run, taskId);
    assert.notEqual(secondAuditId, auditId);

    const result = await harness.run("coach_record_review", { taskId, auditId: secondAuditId });
    assert.equal(result.details.fullPass, true);
    assert.equal(result.details.auditId, secondAuditId);
    assert.equal(result.details.auditAgreed, true);
  } finally {
    harness.cleanup();
  }
});

test("reminder 扩展注册 3 个工具", async () => {
  const rem = await loadExtensions([join(ROOT, "extensions", "reminder", "index.ts")], ROOT);
  if (rem.errors.length > 0) throw new Error(JSON.stringify(rem.errors));
  const names = [...rem.extensions[0].tools].map(([name]) => name).sort();
  assert.deepEqual(names, ["reminder_get", "reminder_set", "reminder_test"]);
});
