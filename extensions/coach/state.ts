/**
 * 学员状态模型与持久化。
 *
 * profile.json 是结构化状态的唯一来源。
 * 学习计划.md 由 profile.plan 生成，不独立维护。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { REMINDER_TIME_RE } from "../reminder/reminder.ts";

export const PROFILE_VERSION = 2;
export const REQUIRED_SPACED_PASSES = 3;

export type KnowledgeState = "new" | "learning" | "review" | "mastered" | "blocked";
export type SessionMode = "init" | "teach" | "review" | "prep" | "plan-review";
export type BaselineSource = "self-report" | "school-result" | "diagnostic";

export type EvidenceKind =
  | "define"
  | "boundary"
  | "distinguish"
  | "relate"
  | "reason"
  | "apply"
  | "example"
  | "counterexample"
  | "self-correct"
  | "near-transfer"
  | "purpose"
  | "derive"
  | "reconstruct"
  | "error";

export type AttemptDepth = "none" | "recognition" | "generative";
export type ProgressState = "new" | "none";
export type TaskMode = "teach" | "review";
export type TaskPhase = "diagnose" | "guide" | "verify" | "paused" | "completed";
export type QuestionRole =
  | "core"
  | "key-subproblem"
  | "connection"
  | "prerequisite-diagnostic"
  | "verification";

export type GuidanceMethod =
  | "none"
  | "locate"
  | "smaller-question"
  | "split"
  | "precision"
  | "structural-example"
  | "analogy"
  | "contrast"
  | "learner-example"
  | "reconstruct"
  | "limited-choice"
  | "context-comparison";

export type OverviewItem = "goal" | "known" | "missing" | "concept" | "relation";
export type VerificationStep = "restate" | "reason" | "near-transfer" | "counterexample" | "return";
export type VerificationStatus = "pending" | "passed" | "failed";
export type ExplanationGate = "A" | "B" | "C" | "prerequisite";
export type NextTeachingAction =
  | "continue"
  | "locate-difficulty"
  | "request-explanation"
  | "test-near-transfer"
  | "increase-support"
  | "offer-limited-choice"
  | "diagnose-prerequisite-or-pause"
  | "pause-for-emotion"
  | "verify-explanation"
  | "finish-or-continue";

export interface BaselineEntry {
  note: string;
  source: BaselineSource;
  observedAt: string;
}

export interface Learner {
  name: string;
  grade: string;
  province: string;
  examMode: string;
  firstElective: string | null;
  secondElectives: string[];
  subjects: string[];
  baseline: {
    globalNote: string;
    bySubject: Record<string, BaselineEntry>;
  };
  schoolProgress: Record<string, string>;
  schedule: {
    dailyMinutes: number | null;
    preferredTime: string | null;
  };
}

export interface PlanFocus {
  knowledgeId: string;
  reason: string;
}

export interface Milestone {
  id: string;
  title: string;
  knowledgeIds: string[];
  successCriteria: string[];
  targetDate: string;
  status: "active" | "done" | "paused";
  completedAt?: string;
  note?: string;
}

export interface SubjectPlanReview {
  subject: string;
  note: string;
  lastReviewedAt: string;
  nextReviewAt: string;
}

export interface StudyPlan {
  revision: number;
  createdAt: string;
  updatedAt: string;
  cycleStart: string;
  cycleEnd: string;
  longTermGoal: string;
  currentFocus: PlanFocus[];
  milestones: Milestone[];
  subjectReviews: Record<string, SubjectPlanReview>;
  dailyRoutine: string[];
  reviewCadenceDays: number;
  lastReviewedAt?: string;
  nextReviewAt: string;
  lastReflection?: string;
}

export interface KnowledgeEvidence {
  date: string;
  taskId: string;
  phase: TaskPhase | "review";
  attemptDepth: AttemptDepth;
  progress: ProgressState;
  correct: boolean;
  independent: boolean;
  kinds: EvidenceKind[];
  questionRole: QuestionRole;
  note?: string;
}

export interface ReviewRecord {
  date: string;
  dueAt: string;
  independent: boolean;
  retrievalCorrect: boolean;
  reasonPassed: boolean;
  transferPassed: boolean;
  boundaryPassed: boolean;
  fullPass: boolean;
  quality: number;
}

export interface LocalVerificationRecord {
  taskId: string;
  completedAt: string;
  method: "socratic" | "explained";
  explanationGate?: ExplanationGate;
  nearTransferPassed: boolean;
  verification?: Record<VerificationStep, VerificationStatus>;
}

export interface KnowledgeNode {
  id: string;
  subject: string;
  name: string;
  state: KnowledgeState;
  catalogMissing?: boolean;
  blockedBy?: string;
  localVerifiedAt?: string;
  localVerification?: LocalVerificationRecord;
  ease: number;
  intervalDays: number;
  repetitions: number;
  spacedPasses: number;
  attempts: number;
  reviews: number;
  lastPractice?: string;
  lastReview?: string;
  nextReview?: string;
  evidence: KnowledgeEvidence[];
  reviewHistory: ReviewRecord[];
}

export interface ProblemMap {
  goal: string;
  known: string;
  missing: string;
  concept: string;
  relation: string;
}

export interface ProblemOverviewEvidence {
  goal: boolean;
  known: boolean;
  missing: boolean;
  concept: boolean;
  relation: boolean;
}

export interface TurnRecord {
  id: string;
  date: string;
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

export interface ExplanationRecord {
  gate: ExplanationGate;
  keyRelation: string;
  authorizedAt: string;
  verification: Record<VerificationStep, VerificationStatus>;
  nextStep: VerificationStep;
  completedAt?: string;
}

export interface ActiveTask {
  id: string;
  knowledgeId: string;
  mode: TaskMode;
  phase: TaskPhase;
  goal: string;
  problemMap: ProblemMap;
  startedAt: string;
  updatedAt: string;
  parentTaskId?: string;
  blockedBy?: string;
  nextStart?: string;
  pauseReason?: "emotion" | "prerequisite" | "manual";
  supportDepth: number;
  methodsUsed: GuidanceMethod[];
  rounds: number;
  meaningfulRounds: number;
  effectiveAttempts: number;
  microProgress: number;
  noProgressStreak: number;
  refusalStreak: number;
  connectionNoProgressStreak: number;
  keySubproblemsTried: number;
  keySubproblemsCorrect: number;
  sameQuestionCount: number;
  lastQuestionKey?: string;
  unresolvedCoreError: boolean;
  overview: ProblemOverviewEvidence;
  nextAction: NextTeachingAction;
  turns: TurnRecord[];
  explanation?: ExplanationRecord;
}

export interface TeachingState {
  activeTask: ActiveTask | null;
  pausedTasks: ActiveTask[];
  completedTasks: ActiveTask[];
}

export interface SessionRecord {
  date: string;
  subject?: string;
  topic?: string;
  durationMin?: number;
  mode: SessionMode;
  outcome?: string;
  feeling?: number;
  nextStart?: string;
}

export interface ReminderConfig {
  enabled: boolean;
  time: string; // "HH:MM" 24h，launchd StartCalendarInterval
}

export interface Profile {
  version: number;
  initialized: boolean;
  learner: Learner;
  plan: StudyPlan | null;
  knowledge: Record<string, KnowledgeNode>;
  teaching: TeachingState;
  sessions: SessionRecord[];
  reminder: ReminderConfig;
}

export const DEFAULT_PROFILE: Profile = {
  version: PROFILE_VERSION,
  initialized: false,
  learner: {
    name: "",
    grade: "高一",
    province: "广东",
    examMode: "3+1+2",
    firstElective: null,
    secondElectives: [],
    subjects: [],
    baseline: { globalNote: "", bySubject: {} },
    schoolProgress: {},
    schedule: { dailyMinutes: null, preferredTime: null },
  },
  plan: null,
  knowledge: {},
  teaching: { activeTask: null, pausedTasks: [], completedTasks: [] },
  sessions: [],
  reminder: { enabled: false, time: "20:00" },
};

export function createKnowledgeNode(id: string, subject: string, name: string): KnowledgeNode {
  return {
    id,
    subject,
    name,
    state: "new",
    ease: 2.5,
    intervalDays: 0,
    repetitions: 0,
    spacedPasses: 0,
    attempts: 0,
    reviews: 0,
    evidence: [],
    reviewHistory: [],
  };
}

export function stateDir(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "state");
}

export function profilePath(cwd: string): string {
  return join(stateDir(cwd), "profile.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeKnowledge(raw: unknown): Record<string, KnowledgeNode> {
  if (!isRecord(raw)) return {};

  const result: Record<string, KnowledgeNode> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;

    const subject = typeof value.subject === "string" ? value.subject : id.split("::")[0] || "";
    const name = typeof value.name === "string" ? value.name : id.split("::").at(-1) || id;
    const node = createKnowledgeNode(id, subject, name);
    const rawState = value.state;
    if (["new", "learning", "review", "mastered", "blocked"].includes(String(rawState))) {
      node.state = rawState as KnowledgeState;
    }

    node.catalogMissing = value.catalogMissing === true;
    node.blockedBy = typeof value.blockedBy === "string" ? value.blockedBy : undefined;
    node.localVerifiedAt = typeof value.localVerifiedAt === "string" ? value.localVerifiedAt : undefined;
    node.localVerification = isRecord(value.localVerification)
      ? (value.localVerification as unknown as LocalVerificationRecord)
      : undefined;
    node.ease = typeof value.ease === "number" ? Math.max(1.3, value.ease) : 2.5;
    node.intervalDays = typeof value.intervalDays === "number" ? Math.max(0, value.intervalDays) : 0;
    node.repetitions = typeof value.repetitions === "number" ? Math.max(0, value.repetitions) : 0;
    node.spacedPasses = typeof value.spacedPasses === "number" ? Math.max(0, value.spacedPasses) : 0;
    node.attempts = typeof value.attempts === "number" ? Math.max(0, value.attempts) : 0;
    node.reviews = typeof value.reviews === "number" ? Math.max(0, value.reviews) : 0;
    node.lastPractice = typeof value.lastPractice === "string" ? value.lastPractice : undefined;
    node.lastReview = typeof value.lastReview === "string" ? value.lastReview : undefined;
    node.nextReview = typeof value.nextReview === "string" ? value.nextReview : undefined;
    node.evidence = Array.isArray(value.evidence) ? (value.evidence as KnowledgeEvidence[]) : [];
    node.reviewHistory = Array.isArray(value.reviewHistory) ? (value.reviewHistory as ReviewRecord[]) : [];

    // 旧版 mastered 没有间隔验证证据。迁移后降为 review。
    if (
      node.state === "mastered" &&
      (!node.localVerifiedAt || !node.localVerification || node.spacedPasses < REQUIRED_SPACED_PASSES)
    ) {
      node.state = "review";
    }
    if (node.state === "blocked" && !node.blockedBy) node.state = "learning";

    result[id] = node;
  }
  return result;
}

function migrateProfile(raw: unknown): Profile {
  if (!isRecord(raw)) return structuredClone(DEFAULT_PROFILE);

  const learnerRaw = isRecord(raw.learner) ? raw.learner : {};
  const oldBaseline = isRecord(learnerRaw.baseline) ? learnerRaw.baseline : {};
  const baseline = isRecord(oldBaseline.bySubject)
    ? {
        globalNote: typeof oldBaseline.globalNote === "string" ? oldBaseline.globalNote : "",
        bySubject: oldBaseline.bySubject as Record<string, BaselineEntry>,
      }
    : {
        globalNote: typeof oldBaseline.note === "string" ? oldBaseline.note : "",
        bySubject: {},
      };

  const profile: Profile = {
    ...structuredClone(DEFAULT_PROFILE),
    initialized: raw.initialized === true,
    learner: {
      ...structuredClone(DEFAULT_PROFILE.learner),
      ...learnerRaw,
      firstElective: typeof learnerRaw.firstElective === "string" ? learnerRaw.firstElective : null,
      secondElectives: Array.isArray(learnerRaw.secondElectives)
        ? learnerRaw.secondElectives.filter((item): item is string => typeof item === "string")
        : [],
      subjects: Array.isArray(learnerRaw.subjects)
        ? learnerRaw.subjects.filter((item): item is string => typeof item === "string")
        : [],
      baseline,
      schoolProgress: isRecord(learnerRaw.schoolProgress)
        ? (learnerRaw.schoolProgress as Record<string, string>)
        : {},
      schedule: {
        dailyMinutes:
          isRecord(learnerRaw.schedule) && typeof learnerRaw.schedule.dailyMinutes === "number"
            ? learnerRaw.schedule.dailyMinutes
            : null,
        preferredTime:
          isRecord(learnerRaw.schedule) && typeof learnerRaw.schedule.preferredTime === "string"
            ? learnerRaw.schedule.preferredTime
            : null,
      },
    },
    plan: isRecord(raw.plan) ? (raw.plan as unknown as StudyPlan) : null,
    knowledge: normalizeKnowledge(raw.knowledge),
    teaching: isRecord(raw.teaching)
      ? {
          activeTask: isRecord(raw.teaching.activeTask) ? (raw.teaching.activeTask as unknown as ActiveTask) : null,
          pausedTasks: Array.isArray(raw.teaching.pausedTasks)
            ? (raw.teaching.pausedTasks as ActiveTask[])
            : [],
          completedTasks: Array.isArray(raw.teaching.completedTasks)
            ? (raw.teaching.completedTasks as ActiveTask[])
            : [],
        }
      : { activeTask: null, pausedTasks: [], completedTasks: [] },
    sessions: Array.isArray(raw.sessions) ? (raw.sessions as SessionRecord[]) : [],
    reminder: (() => {
      const r = isRecord(raw.reminder) ? raw.reminder : {};
      return {
        enabled: typeof r.enabled === "boolean" ? r.enabled : false,
        time: typeof r.time === "string" && REMINDER_TIME_RE.test(r.time) ? r.time : "20:00",
      };
    })(),
    version: PROFILE_VERSION,
  };

  return profile;
}

export function loadProfile(cwd: string): Profile {
  const path = profilePath(cwd);
  if (!existsSync(path)) return structuredClone(DEFAULT_PROFILE);

  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(raw)) throw new Error("根值必须是 JSON 对象");
    return migrateProfile(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取学员状态 ${path}：${message}`);
  }
}

export function saveProfile(cwd: string, profile: Profile): void {
  mkdirSync(stateDir(cwd), { recursive: true });
  profile.version = PROFILE_VERSION;
  const target = profilePath(cwd);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, JSON.stringify(profile, null, 2) + "\n", "utf8");
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function cloneProfile(profile: Profile): Profile {
  return structuredClone(profile);
}
