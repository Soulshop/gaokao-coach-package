import type {
  ActiveTask,
  AttemptDepth,
  EvidenceKind,
  ExplanationGate,
  ExplanationRecord,
  GuidanceMethod,
  NextTeachingAction,
  OverviewItem,
  ProblemMap,
  ProgressState,
  QuestionRole,
  TurnRecord,
  VerificationStatus,
  VerificationStep,
} from "./state.ts";

export const VERIFICATION_STEPS: VerificationStep[] = [
  "restate",
  "reason",
  "near-transfer",
  "counterexample",
  "return",
];

const RELATION_KINDS = new Set<EvidenceKind>(["relate", "apply"]);
const REASON_KINDS = new Set<EvidenceKind>(["reason", "example", "counterexample", "derive"]);
const DECOMPOSITION_METHODS = new Set<GuidanceMethod>([
  "smaller-question",
  "split",
  "limited-choice",
]);

export interface TurnInput {
  questionKey: string;
  questionRole: QuestionRole;
  guidanceMethod: GuidanceMethod;
  supportDepth: number;
  attemptDepth: AttemptDepth;
  progress: ProgressState;
  emotionalSignal: boolean;
  refused: boolean;
  correct: boolean;
  independent: boolean;
  evidenceKinds: EvidenceKind[];
  overviewItems: OverviewItem[];
  coreError: boolean;
  pathId?: string;
  blockedRelation?: string;
  candidatePrerequisiteId?: string;
  note?: string;
}

export interface ReadinessResult {
  ready: boolean;
  signals: EvidenceKind[];
  hasRelation: boolean;
  hasReasonOrExample: boolean;
  unresolvedCoreError: boolean;
}

export interface OverviewResult {
  ready: boolean;
  correctCount: number;
  requiredItemsReady: boolean;
}

export interface ExplanationEligibility {
  globalReady: boolean;
  groups: Record<"A" | "B" | "C", boolean>;
  prohibitions: string[];
  facts: {
    distinctGuidanceMethods: number;
    keySubproblemsTried: number;
    keySubproblemsCorrect: number;
    connectionNoProgressStreak: number;
    meaningfulRounds: number;
    effectiveAttempts: number;
    lastThreeNoProgress: boolean;
    matchingFailedPaths: number;
    readiness: boolean;
    overview: boolean;
    recordedBlockedRelations: string[];
  };
}

export function createActiveTask(input: {
  id: string;
  knowledgeId: string;
  mode: "teach" | "review";
  goal: string;
  problemMap: ProblemMap;
  now: string;
  parentTaskId?: string;
}): ActiveTask {
  return {
    id: input.id,
    knowledgeId: input.knowledgeId,
    mode: input.mode,
    phase: "diagnose",
    goal: input.goal,
    problemMap: input.problemMap,
    startedAt: input.now,
    updatedAt: input.now,
    parentTaskId: input.parentTaskId,
    supportDepth: 0,
    methodsUsed: [],
    rounds: 0,
    meaningfulRounds: 0,
    effectiveAttempts: 0,
    microProgress: 0,
    noProgressStreak: 0,
    refusalStreak: 0,
    connectionNoProgressStreak: 0,
    keySubproblemsTried: 0,
    keySubproblemsCorrect: 0,
    sameQuestionCount: 0,
    unresolvedCoreError: false,
    overview: {
      goal: false,
      known: false,
      missing: false,
      concept: false,
      relation: false,
    },
    nextAction: "continue",
    turns: [],
  };
}

function validateTurnInput(task: ActiveTask, input: TurnInput): void {
  if (!input.questionKey.trim()) throw new Error("questionKey 不能为空");
  if (task.lastQuestionKey === input.questionKey) {
    const previous = [...task.turns].reverse().find((turn) => turn.questionKey === input.questionKey);
    if (
      previous &&
      previous.guidanceMethod === input.guidanceMethod &&
      previous.supportDepth === input.supportDepth
    ) {
      throw new Error(`同一 questionKey 第二次使用必须改变引导方法或支持深度：${input.questionKey}`);
    }
  }
  if (task.mode === "review" && (input.guidanceMethod !== "none" || input.supportDepth !== 0)) {
    throw new Error("到期复习评估不能提供引导或增加支持深度");
  }
  if (task.mode === "teach" && task.rounds === 0 && input.supportDepth !== 0) {
    throw new Error("新教学任务必须从支持深度 0 开始");
  }
  if (task.mode === "teach" && task.rounds > 0) {
    if (task.nextAction === "pause-for-emotion") {
      throw new Error("连续两轮拒绝后必须暂停任务，不能继续追问");
    }
    if (task.nextAction === "request-explanation") {
      throw new Error("当前必须先申请讲解授权，不能继续普通追问");
    }
    if (task.nextAction === "continue" && input.supportDepth > task.supportDepth) {
      throw new Error("没有升级指令时不能增加支持深度");
    }
    if (
      task.nextAction === "locate-difficulty" &&
      (input.guidanceMethod !== "locate" || input.supportDepth !== Math.min(4, task.supportDepth + 1))
    ) {
      throw new Error("首次无进展后必须用 locate 增加一级支持");
    }
    if (
      task.nextAction === "increase-support" &&
      input.supportDepth !== Math.min(4, task.supportDepth + 1)
    ) {
      throw new Error("连续两轮无进展后必须增加一级支持深度");
    }
    if (task.nextAction === "offer-limited-choice" && input.guidanceMethod !== "limited-choice") {
      throw new Error("连续三轮无进展后必须使用 limited-choice");
    }
    if (
      task.nextAction === "diagnose-prerequisite-or-pause" &&
      input.questionRole !== "prerequisite-diagnostic"
    ) {
      throw new Error("连续四轮无进展后只能做前置诊断或暂停任务");
    }
    if (
      task.nextAction === "diagnose-prerequisite-or-pause" &&
      input.questionRole === "prerequisite-diagnostic"
    ) {
      const failedDiagnostics = task.turns.filter(
        (turn) => turn.questionRole === "prerequisite-diagnostic" && turn.progress === "none",
      ).length;
      if (failedDiagnostics >= 2) {
        throw new Error("已做两次失败的前置诊断。继续做诊断或暂停，并确认阻塞。");
      }
    }
  }
  if (!Number.isInteger(input.supportDepth) || input.supportDepth < 0 || input.supportDepth > 4) {
    throw new Error("supportDepth 必须是 0..4 的整数");
  }
  if (
    input.refused &&
    (input.attemptDepth !== "none" || input.progress !== "none" || input.correct || input.independent)
  ) {
    throw new Error("拒绝作答时尝试、进展、正确性和独立性必须为否");
  }
  if (input.attemptDepth === "none" && (input.correct || input.independent)) {
    throw new Error("无尝试回答不能记录为正确或独立");
  }
  if (input.progress === "new" && (!input.correct || input.attemptDepth === "none")) {
    throw new Error("新增进展必须来自正确的生成性尝试或微进展");
  }
  if (input.attemptDepth === "recognition" && input.evidenceKinds.length > 0) {
    throw new Error("微进展不能携带掌握证据类型");
  }
  if (input.attemptDepth === "generative" && input.evidenceKinds.length === 0) {
    throw new Error("生成性尝试必须包含至少一个 evidenceKind");
  }
  if (input.coreError && input.progress === "new") {
    throw new Error("存在核心错误时不能记录 new progress");
  }
  if (input.questionRole === "prerequisite-diagnostic" && !input.candidatePrerequisiteId) {
    throw new Error("前置诊断必须提供 candidatePrerequisiteId");
  }
  // blockedRelation 只被讲解门槛组 A/C 消费，且两组都只统计无进展轮次。
  // 因此只在无进展时必填；有进展时填写无意义，不强制。
  if (
    input.questionRole === "connection" &&
    input.progress === "none" &&
    !input.blockedRelation?.trim()
  ) {
    throw new Error("无进展的连接问题必须提供 blockedRelation，指明学员未能跨越的关系");
  }
  if (input.pathId && input.progress === "none" && !input.blockedRelation?.trim()) {
    throw new Error("无进展的路径记录必须提供 blockedRelation，指明学员未能跨越的关系");
  }

  const nextSameCount = task.lastQuestionKey === input.questionKey ? task.sameQuestionCount + 1 : 1;
  if (nextSameCount > 2) {
    throw new Error(`同一 questionKey 不得使用超过两次：${input.questionKey}`);
  }
}

function successfulKinds(task: ActiveTask): EvidenceKind[] {
  const turns = task.turns
    .filter(
      (turn) =>
        turn.attemptDepth === "generative" &&
        turn.progress === "new" &&
        !turn.coreError &&
        turn.correct,
    )
    .slice(-4);
  return [...new Set(turns.flatMap((turn) => turn.evidenceKinds).filter((kind) => kind !== "error"))];
}

export function computeReadiness(task: ActiveTask): ReadinessResult {
  const signals = successfulKinds(task);
  const hasRelation = signals.some((kind) => RELATION_KINDS.has(kind));
  const hasReasonOrExample = signals.some((kind) => REASON_KINDS.has(kind));
  const ready = signals.length >= 3 && hasRelation && hasReasonOrExample && !task.unresolvedCoreError;
  return {
    ready,
    signals,
    hasRelation,
    hasReasonOrExample,
    unresolvedCoreError: task.unresolvedCoreError,
  };
}

export function computeOverview(task: ActiveTask): OverviewResult {
  const values = Object.values(task.overview);
  const correctCount = values.filter(Boolean).length;
  const requiredItemsReady = task.overview.goal && task.overview.concept && task.overview.relation;
  return { ready: correctCount >= 4 && requiredItemsReady && !task.unresolvedCoreError, correctCount, requiredItemsReady };
}

export function hasSuccessfulEvidence(task: ActiveTask, kind: EvidenceKind): boolean {
  return task.turns.some(
    (turn) => turn.correct && turn.progress === "new" && !turn.coreError && turn.evidenceKinds.includes(kind),
  );
}

export function recommendNextAction(task: ActiveTask): NextTeachingAction {
  if (task.mode === "review") {
    const failed = task.turns.some(
      (turn) => !turn.correct || !turn.independent || turn.progress === "none" || turn.refused || turn.coreError,
    );
    const complete =
      task.turns.some((turn) => turn.evidenceKinds.some((kind) => ["define", "relate", "apply", "reconstruct"].includes(kind))) &&
      task.turns.some((turn) => turn.evidenceKinds.some((kind) => ["reason", "derive"].includes(kind))) &&
      task.turns.some((turn) => turn.evidenceKinds.includes("near-transfer")) &&
      task.turns.some((turn) => turn.evidenceKinds.some((kind) => ["boundary", "counterexample"].includes(kind)));
    return failed || complete ? "finish-or-continue" : "continue";
  }
  if (task.refusalStreak >= 2) return "pause-for-emotion";
  if (task.noProgressStreak < 4) {
    const eligibility = computeExplanationEligibility(task, task.problemMap.relation);
    if (eligibility.groups.A || eligibility.groups.B || eligibility.groups.C) {
      return "request-explanation";
    }
  }
  if (task.noProgressStreak >= 4) return "diagnose-prerequisite-or-pause";
  if (task.noProgressStreak === 3) return "offer-limited-choice";
  if (task.noProgressStreak === 2) return "increase-support";
  if (task.noProgressStreak === 1) return "locate-difficulty";

  const readiness = computeReadiness(task);
  if (readiness.ready && !hasSuccessfulEvidence(task, "near-transfer")) return "test-near-transfer";
  if (readiness.ready && hasSuccessfulEvidence(task, "near-transfer")) return "finish-or-continue";
  return "continue";
}

export function applyTurn(task: ActiveTask, input: TurnInput, now: string, turnId: string): TurnRecord {
  validateTurnInput(task, input);

  const turn: TurnRecord = {
    id: turnId,
    date: now,
    questionKey: input.questionKey.trim(),
    questionRole: input.questionRole,
    guidanceMethod: input.guidanceMethod,
    supportDepth: input.supportDepth,
    attemptDepth: input.attemptDepth,
    progress: input.progress,
    emotionalSignal: input.emotionalSignal,
    refused: input.refused,
    correct: input.correct,
    independent: input.independent,
    evidenceKinds: [...new Set(input.evidenceKinds)],
    overviewItems: [...new Set(input.overviewItems)],
    coreError: input.coreError,
    pathId: input.pathId?.trim() || undefined,
    blockedRelation: input.blockedRelation?.trim() || undefined,
    candidatePrerequisiteId: input.candidatePrerequisiteId,
    note: input.note?.trim() || undefined,
  };

  task.turns.push(turn);
  task.rounds += 1;
  task.updatedAt = now;
  task.phase = task.explanation ? "verify" : "guide";
  task.supportDepth = input.supportDepth;
  task.sameQuestionCount = task.lastQuestionKey === turn.questionKey ? task.sameQuestionCount + 1 : 1;
  task.lastQuestionKey = turn.questionKey;

  if (turn.guidanceMethod !== "none" && !task.methodsUsed.includes(turn.guidanceMethod)) {
    task.methodsUsed.push(turn.guidanceMethod);
  }
  if (turn.attemptDepth !== "none") task.meaningfulRounds += 1;
  if (turn.attemptDepth === "generative") task.effectiveAttempts += 1;
  if (turn.attemptDepth === "recognition") task.microProgress += 1;

  if (turn.progress === "new") task.noProgressStreak = 0;
  else task.noProgressStreak += 1;

  if (turn.refused) task.refusalStreak += 1;
  else task.refusalStreak = 0;

  if (turn.questionRole === "connection") {
    if (turn.progress === "none") task.connectionNoProgressStreak += 1;
    else task.connectionNoProgressStreak = 0;
  }

  if (turn.questionRole === "key-subproblem") {
    task.keySubproblemsTried += 1;
    if (turn.correct) task.keySubproblemsCorrect += 1;
  }

  if (turn.coreError) task.unresolvedCoreError = true;
  if (turn.correct && turn.evidenceKinds.includes("self-correct")) task.unresolvedCoreError = false;

  if (turn.attemptDepth === "generative" && turn.correct && turn.independent && !turn.coreError) {
    for (const item of turn.overviewItems) task.overview[item] = true;
  }

  task.nextAction = task.explanation ? "verify-explanation" : recommendNextAction(task);
  return turn;
}

function hasBasicConcept(task: ActiveTask): boolean {
  return task.overview.concept || hasSuccessfulEvidence(task, "define");
}

export function computeExplanationEligibility(
  task: ActiveTask,
  keyRelation: string,
): ExplanationEligibility {
  const readiness = computeReadiness(task);
  const overview = computeOverview(task);
  const methods = task.methodsUsed.filter((method) => method !== "none");
  const distinctGuidanceMethods = new Set(methods).size;
  const prohibitions: string[] = [];

  if (!keyRelation.trim()) prohibitions.push("缺少要讲的单一关键关系");
  if (!hasBasicConcept(task)) prohibitions.push("核心概念基本含义未建立");
  if (!task.overview.goal) prohibitions.push("学员尚未独立识别目标");
  if (!task.overview.known) prohibitions.push("学员尚未独立识别关键条件");
  if (task.refusalStreak > 0) prohibitions.push("当前存在情绪拒绝");
  if (task.noProgressStreak >= 4) prohibitions.push("已到前置诊断或暂停节点");
  if (distinctGuidanceMethods < 3) prohibitions.push("不足三个不同引导方法");
  const failedDiagnostics = task.turns.filter(
    (turn) => turn.questionRole === "prerequisite-diagnostic" && turn.progress === "none",
  ).length;
  if (failedDiagnostics >= 2) prohibitions.push("已出现两次失败的前置诊断，应先确认前置阻塞");
  if (!methods.some((method) => DECOMPOSITION_METHODS.has(method))) {
    prohibitions.push("尚未使用降级、拆分或有限选择");
  }

  const lastThree = task.turns.slice(-3);
  const lastThreeNoProgress = lastThree.length === 3 && lastThree.every((turn) => turn.progress === "none");
  const matchingPaths = new Set(
    task.turns
      .filter(
        (turn) =>
          turn.pathId &&
          turn.attemptDepth === "generative" &&
          turn.progress === "none" &&
          turn.blockedRelation?.trim() === keyRelation.trim(),
      )
      .map((turn) => turn.pathId as string),
  ).size;
  let matchingConnectionStreak = 0;
  for (let index = task.turns.length - 1; index >= 0; index--) {
    const turn = task.turns[index];
    if (
      turn.questionRole === "connection" &&
      turn.progress === "none" &&
      turn.blockedRelation?.trim() === keyRelation.trim()
    ) {
      matchingConnectionStreak += 1;
      continue;
    }
    break;
  }

  const globalReady = prohibitions.length === 0;
  const groupA =
    globalReady &&
    task.keySubproblemsTried >= 3 &&
    task.keySubproblemsCorrect >= 2 &&
    matchingConnectionStreak >= 2;
  const groupB =
    globalReady &&
    task.meaningfulRounds >= 6 &&
    task.effectiveAttempts >= 3 &&
    lastThreeNoProgress &&
    readiness.ready &&
    overview.ready;
  const groupC = globalReady && overview.ready && matchingPaths >= 2;

  return {
    globalReady,
    groups: { A: groupA, B: groupB, C: groupC },
    prohibitions,
    facts: {
      distinctGuidanceMethods,
      keySubproblemsTried: task.keySubproblemsTried,
      keySubproblemsCorrect: task.keySubproblemsCorrect,
      connectionNoProgressStreak: matchingConnectionStreak,
      meaningfulRounds: task.meaningfulRounds,
      effectiveAttempts: task.effectiveAttempts,
      lastThreeNoProgress,
      matchingFailedPaths: matchingPaths,
      readiness: readiness.ready,
      overview: overview.ready,
      recordedBlockedRelations: [
        ...new Set(
          task.turns
            .filter((turn) => turn.progress === "none" && turn.blockedRelation?.trim())
            .map((turn) => (turn.blockedRelation as string).trim()),
        ),
      ],
    },
  };
}

export function createExplanation(gate: ExplanationGate, keyRelation: string, now: string): ExplanationRecord {
  const verification = Object.fromEntries(
    VERIFICATION_STEPS.map((step) => [step, "pending" as VerificationStatus]),
  ) as Record<VerificationStep, VerificationStatus>;
  return {
    gate,
    keyRelation: keyRelation.trim(),
    authorizedAt: now,
    verification,
    nextStep: VERIFICATION_STEPS[0],
  };
}

export function recordVerificationStatus(
  explanation: ExplanationRecord,
  step: VerificationStep,
  passed: boolean,
  now: string,
): void {
  if (explanation.completedAt) throw new Error("五步验证已经完成，不能重复记录");
  if (explanation.nextStep !== step) {
    throw new Error(`验证必须按序进行。当前步骤是 ${explanation.nextStep}`);
  }
  explanation.verification[step] = passed ? "passed" : "failed";
  if (!passed) return;

  const index = VERIFICATION_STEPS.indexOf(step);
  const next = VERIFICATION_STEPS[index + 1];
  if (next) {
    explanation.nextStep = next;
    return;
  }
  explanation.completedAt = now;
}

export function verificationRemediation(step: VerificationStep): string {
  switch (step) {
    case "restate":
      return "使用 precision，引导学员重新用自己的话复述。不得重讲。";
    case "reason":
      return "使用 structural-example、analogy 或 contrast。只追失败的理由。不得重讲。";
    case "near-transfer":
      return "使用 context-comparison，比较新旧情境。不得重讲。";
    case "counterexample":
      return "使用 contrast，给对比例。不得重讲。";
    case "return":
      return "只追原题中失败的下一步。不得重讲。";
  }
}

export function allVerificationPassed(explanation: ExplanationRecord): boolean {
  return VERIFICATION_STEPS.every((step) => explanation.verification[step] === "passed");
}

export function canFinishLocally(task: ActiveTask): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (task.mode !== "teach") reasons.push("复习任务必须用 coach_record_review 结束");
  if (task.unresolvedCoreError) reasons.push("仍有未修正的核心错误");

  if (task.explanation) {
    if (!allVerificationPassed(task.explanation)) reasons.push("讲后五步验证尚未全部通过");
  } else {
    const readiness = computeReadiness(task);
    if (!readiness.ready) reasons.push("当前概念准备度不足");
    if (!hasSuccessfulEvidence(task, "near-transfer")) reasons.push("尚未通过近迁移");
  }

  return { allowed: reasons.length === 0, reasons };
}

export function resetTaskForResume(task: ActiveTask, now: string): void {
  const verificationComplete = task.explanation ? allVerificationPassed(task.explanation) : false;
  task.phase = task.explanation ? "verify" : "diagnose";
  task.updatedAt = now;
  task.blockedBy = undefined;
  task.nextStart = undefined;
  task.supportDepth = 0;
  task.noProgressStreak = 0;
  task.refusalStreak = 0;
  task.connectionNoProgressStreak = 0;
  task.sameQuestionCount = 0;
  task.lastQuestionKey = undefined;
  task.nextAction = task.explanation
    ? verificationComplete
      ? "finish-or-continue"
      : "verify-explanation"
    : "continue";
}

export function reviewQuality(input: {
  independent: boolean;
  retrievalCorrect: boolean;
  reasonPassed: boolean;
  transferPassed: boolean;
  boundaryPassed: boolean;
}): { quality: number; fullPass: boolean } {
  const fullPass =
    input.independent &&
    input.retrievalCorrect &&
    input.reasonPassed &&
    input.transferPassed &&
    input.boundaryPassed;
  if (fullPass) return { quality: 5, fullPass: true };
  if (!input.retrievalCorrect) return { quality: 1, fullPass: false };
  return { quality: 2, fullPass: false };
}
