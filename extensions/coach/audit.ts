/**
 * 评分审计：第二评分者判定的一致性记录。
 *
 * 执教模型当场判定每个回合的 correct、attemptDepth 与 evidenceKinds。
 * 本模块把执教判定与复评员（grading-auditor 子代理）的独立盲评逐维比较，
 * 并把双方判定与仲裁追加到 grading-audit.jsonl（只追加日志）。
 *
 * 该日志含学员原话（仲裁证据），属学员数据，消费端 .gitignore 必须忽略 .pi/state/。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AttemptDepth, EvidenceKind, ProgressState } from "./state.ts";

// state.ts 的 stateDir 引自 pi 核心包。本文件在纯 node 测试中也要可加载，
// 因此不导入 state.ts 的运行值，在这里内联同一路径规则。
function auditStateDir(cwd: string): string {
  return join(cwd, ".pi", "state");
}

export type AuditKind = "turn-sample" | "review";
export type ArbitrationDecision = "coach" | "auditor";

export const AUDIT_KINDS: AuditKind[] = ["turn-sample", "review"];
export const ARBITRATION_DECISIONS: ArbitrationDecision[] = ["coach", "auditor"];

export const TURN_AUDIT_DIMENSIONS = [
  "correct",
  "attemptDepth",
  "progress",
  "independent",
  "evidenceKinds",
] as const;
export const REVIEW_AUDIT_DIMENSIONS = [
  "independent",
  "retrievalCorrect",
  "reasonPassed",
  "transferPassed",
  "boundaryPassed",
] as const;

/** 教学回合盲评的五个判定维度。 */
export interface TurnAuditLabels {
  correct: boolean;
  attemptDepth: AttemptDepth;
  progress: ProgressState;
  independent: boolean;
  evidenceKinds: EvidenceKind[];
}

/** 复习复评的五项标准，与 coach_record_review 的判定面一致。 */
export interface ReviewAuditLabels {
  independent: boolean;
  retrievalCorrect: boolean;
  reasonPassed: boolean;
  transferPassed: boolean;
  boundaryPassed: boolean;
}

export interface AuditArbitration {
  dimension: string;
  decision: ArbitrationDecision;
  /** 裁定所依据的学员原话引用。 */
  evidenceQuote: string;
}

export interface AuditRecord {
  id: string;
  date: string;
  kind: AuditKind;
  taskId: string;
  knowledgeId: string;
  /** turn-sample 必填：被抽审回合的 questionKey。 */
  questionRef?: string;
  coach: TurnAuditLabels | ReviewAuditLabels;
  auditor: TurnAuditLabels | ReviewAuditLabels;
  arbitrations: AuditArbitration[];
  agreed: boolean;
}

export interface AuditStats {
  total: number;
  agreed: number;
  disagreements: number;
  agreementRate: number | null;
  byKind: Record<AuditKind, { total: number; agreed: number }>;
}

export function gradingAuditPath(cwd: string): string {
  return join(auditStateDir(cwd), "grading-audit.jsonl");
}

function sortedSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function dimensionsOf(kind: AuditKind): readonly string[] {
  return kind === "review" ? REVIEW_AUDIT_DIMENSIONS : TURN_AUDIT_DIMENSIONS;
}

/** 逐维比较执教判定与复评判定，返回不一致的维度名列表。 */
export function differingDimensions(
  kind: AuditKind,
  coach: TurnAuditLabels | ReviewAuditLabels,
  auditor: TurnAuditLabels | ReviewAuditLabels,
): string[] {
  return dimensionsOf(kind).filter((dimension) => {
    if (kind === "turn-sample" && dimension === "evidenceKinds") {
      const left = sortedSet((coach as TurnAuditLabels).evidenceKinds);
      const right = sortedSet((auditor as TurnAuditLabels).evidenceKinds);
      return left.join(",") !== right.join(",");
    }
    const left = (coach as Record<string, unknown>)[dimension];
    const right = (auditor as Record<string, unknown>)[dimension];
    return left !== right;
  });
}

/** 返回尚未被仲裁覆盖的不一致维度。 */
export function missingArbitrations(
  differing: string[],
  arbitrations: AuditArbitration[],
): string[] {
  const covered = new Set(arbitrations.map((item) => item.dimension));
  return differing.filter((dimension) => !covered.has(dimension));
}

/** 读取审计日志。损坏行（追加中断残留）跳过。 */
export function readAuditLog(cwd: string): AuditRecord[] {
  const path = gradingAuditPath(cwd);
  if (!existsSync(path)) return [];
  const records: AuditRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as AuditRecord);
    } catch {
      // 追加写入中断可能留下半行，忽略。
    }
  }
  return records;
}

/** 追加一条审计记录。调用方必须处于该文件的写入队列内。 */
export function appendAuditRecord(cwd: string, record: AuditRecord): void {
  mkdirSync(auditStateDir(cwd), { recursive: true });
  appendFileSync(gradingAuditPath(cwd), `${JSON.stringify(record)}\n`, "utf8");
}

export function auditStats(records: AuditRecord[]): AuditStats {
  const byKind: AuditStats["byKind"] = {
    "turn-sample": { total: 0, agreed: 0 },
    review: { total: 0, agreed: 0 },
  };
  let agreed = 0;
  for (const record of records) {
    byKind[record.kind].total += 1;
    if (record.agreed) {
      agreed += 1;
      byKind[record.kind].agreed += 1;
    }
  }
  return {
    total: records.length,
    agreed,
    disagreements: records.length - agreed,
    agreementRate: records.length === 0 ? null : agreed / records.length,
    byKind,
  };
}
