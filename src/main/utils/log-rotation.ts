/**
 * When the log file should roll over to the next day.
 *
 * Local midnight, not UTC. The filename is a date a person reads off a bug
 * report, so a run at 8pm in a negative-offset timezone belongs in today's
 * file, not tomorrow's. Matches todayISO in date-range.ts, which is what names
 * the file.
 *
 * Kept separate from logger.ts so the boundary arithmetic — month ends, year
 * ends, DST — can be tested without standing up pino and a real file.
 */
import { todayISO } from "./date-range";

/**
 * Epoch ms of the next local midnight strictly after `now`.
 *
 * Built from the calendar fields rather than by adding 86_400_000, so it stays
 * correct across DST: the day a clock springs forward is 23 hours long, and an
 * arithmetic day would land at 1am and roll the file early.
 */
export function nextLocalMidnight(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).getTime();
}

export interface RollDecision {
  /** Whether to open a new file. */
  roll: boolean;
  /** The day stamp to use — the current one when not rolling. */
  day: string;
  /** When to next consider rolling. */
  nextCheckAt: number;
}

/**
 * Decide whether the active log file is still the right one.
 *
 * Compares day stamps rather than trusting the deadline alone: a machine that
 * slept through midnight, or had its clock corrected, arrives here late and
 * still needs the file swapped. Conversely a DST shift can push the deadline
 * past without the date changing, which must not spuriously reopen the file.
 */
export function decideRoll(currentDay: string, deadline: number, now: Date): RollDecision {
  if (now.getTime() < deadline) {
    return { roll: false, day: currentDay, nextCheckAt: deadline };
  }
  const day = todayISO(now);
  return { roll: day !== currentDay, day, nextCheckAt: nextLocalMidnight(now) };
}
