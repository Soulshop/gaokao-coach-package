/**
 * 间隔复习调度。
 *
 * 只有一次完整的到期复习可以调用 sm2。
 * 对话中的即时尝试不能推进 repetitions 或 intervalDays。
 */
export interface Sm2Input {
  quality: number;
  ease: number;
  intervalDays: number;
  repetitions: number;
}

export interface Sm2Output {
  intervalDays: number;
  ease: number;
  repetitions: number;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function sm2(input: Sm2Input): Sm2Output {
  const quality = clamp(Math.round(input.quality), 0, 5);
  let ease = input.ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  ease = Math.max(1.3, ease);

  if (quality < 3) {
    return { intervalDays: 1, ease, repetitions: 0 };
  }

  const repetitions = input.repetitions + 1;
  if (repetitions === 1) return { intervalDays: 1, ease, repetitions };
  if (repetitions === 2) return { intervalDays: 6, ease, repetitions };

  return {
    intervalDays: Math.max(1, Math.round(input.intervalDays * ease)),
    ease,
    repetitions,
  };
}

export function addDays(iso: string | undefined, days: number): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isDue(nextReview: string | undefined, now: Date = new Date()): boolean {
  if (!nextReview) return false;
  const due = new Date(nextReview);
  return !Number.isNaN(due.getTime()) && due <= now;
}
