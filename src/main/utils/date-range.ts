/**
 * Date-range arithmetic for commitment tracking.
 *
 * Dependency-free on purpose: every other module in this feature transitively
 * imports Electron and therefore cannot be unit tested (see
 * src/main/utils/label-sync-throttle.ts for the same split). All real logic
 * lives here so it can be covered.
 *
 * REPRESENTATION: plain `YYYY-MM-DD` local wall dates, both ends inclusive.
 * Sponsor windows are business facts, not instants, so there is no time and no
 * zone. Because ISO dates sort lexicographically, chronological comparison is
 * plain string comparison and there is no parse step to get wrong.
 *
 * HARD RULE: never call `new Date("2026-03-03")` in this feature. A bare ISO
 * date is parsed as UTC midnight, which lands on the previous day in every
 * negative-offset timezone — the bug currently live in the calendar
 * extension's date-extractor (`toISODate` there round-trips through
 * `toISOString()`). Where a real Date is unavoidable, construct it with
 * explicit numeric parts, which JS interprets as local time.
 */

/** An inclusive date range. `null` on either end means open-ended. */
export interface DateRange {
  start: string | null;
  end: string | null;
}

/**
 * How precisely the range is known. Drives conflict strength: `exact` and
 * `week` are hard conflicts we route around, everything coarser only warns —
 * treating "sometime in March" as a block on all of March would refuse real
 * revenue for a date the counterparty never actually pinned down.
 */
export type DatePrecision = "exact" | "week" | "month" | "quarter" | "open_ended" | "none";

/** Sentinels for open-ended comparison. Mirrored in SQL via COALESCE so the
 *  query and this module can never disagree about an open range. */
export const OPEN_START = "0000-01-01";
export const OPEN_END = "9999-12-31";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string | null | undefined): value is string {
  return typeof value === "string" && ISO_DATE.test(value);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Today as YYYY-MM-DD in local time. Clock injectable for tests. */
export function todayISO(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** Split an ISO date into numeric parts without going through Date. */
function parts(iso: string): { y: number; m: number; d: number } {
  return {
    y: Number(iso.slice(0, 4)),
    m: Number(iso.slice(5, 7)),
    d: Number(iso.slice(8, 10)),
  };
}

function toISO(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
}

/** Days in a month, 1-indexed month. */
export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one. Numeric-parts
  // construction is local-time, so no UTC shift.
  return new Date(year, month, 0).getDate();
}

/** Shift an ISO date by whole days. Uses numeric-parts construction, never
 *  string parsing, so it is timezone- and DST-safe. */
export function addDays(iso: string, days: number): string {
  const { y, m, d } = parts(iso);
  const dt = new Date(y, m - 1, d + days);
  return toISO(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

/** Inclusive day count between two ISO dates. `a` and `b` inclusive → >= 1. */
export function daysBetween(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  const ms = new Date(pb.y, pb.m - 1, pb.d).getTime() - new Date(pa.y, pa.m - 1, pa.d).getTime();
  // Round rather than floor: a DST transition inside the span makes the
  // difference 23 or 25 hours, which would otherwise be off by one.
  return Math.round(ms / 86_400_000) + 1;
}

function coalesceStart(v: string | null): string {
  return v ?? OPEN_START;
}

function coalesceEnd(v: string | null): string {
  return v ?? OPEN_END;
}

/**
 * Do two inclusive ranges share at least one day?
 *
 * Inclusive on both ends, so ranges that merely touch (Mar 1–3 and Mar 4–6) do
 * NOT overlap, but Mar 1–3 and Mar 3–6 do.
 */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return (
    coalesceStart(a.start) <= coalesceEnd(b.end) && coalesceStart(b.start) <= coalesceEnd(a.end)
  );
}

/**
 * Resolve a year for a month/day that was written without one.
 *
 * Sponsor mail says "Mar 3-14" and means the next occurrence. Anchoring to the
 * email's sent date (not today) keeps backfill and re-processing stable: the
 * same email always resolves to the same year no matter when it is read.
 * A candidate more than `graceDays` before the send date is assumed to mean
 * next year, which tolerates a sponsor referring to a window that just began.
 */
export function resolveYear(
  month: number,
  day: number,
  sentDateISO: string,
  graceDays = 60,
): string {
  const { y } = parts(sentDateISO);
  const candidate = toISO(y, month, Math.min(day, daysInMonth(y, month)));
  if (daysBetween(candidate, sentDateISO) - 1 > graceDays) {
    const ny = y + 1;
    return toISO(ny, month, Math.min(day, daysInMonth(ny, month)));
  }
  return candidate;
}

/**
 * Expand a coarse phrase into a concrete range plus the precision we actually
 * have. The vocabulary is fixed and enumerated rather than left to a model, so
 * the same phrase always produces the same window and every case is testable.
 */
export function expandFuzzyRange(
  kind: "exact" | "week-of" | "early" | "mid" | "late" | "month" | "quarter" | "open-start",
  opts: { year: number; month?: number; day?: number; quarter?: number; end?: string },
): { range: DateRange; precision: DatePrecision } {
  const { year, month, day, quarter } = opts;

  switch (kind) {
    case "exact":
      return {
        range: { start: toISO(year, month!, day!), end: opts.end ?? toISO(year, month!, day!) },
        precision: "exact",
      };
    case "week-of": {
      const start = toISO(year, month!, day!);
      return { range: { start, end: addDays(start, 6) }, precision: "week" };
    }
    case "early":
      return {
        range: { start: toISO(year, month!, 1), end: toISO(year, month!, 10) },
        precision: "month",
      };
    case "mid":
      return {
        range: { start: toISO(year, month!, 11), end: toISO(year, month!, 20) },
        precision: "month",
      };
    case "late":
      return {
        range: {
          start: toISO(year, month!, 21),
          end: toISO(year, month!, daysInMonth(year, month!)),
        },
        precision: "month",
      };
    case "month":
      return {
        range: {
          start: toISO(year, month!, 1),
          end: toISO(year, month!, daysInMonth(year, month!)),
        },
        precision: "month",
      };
    case "quarter": {
      const firstMonth = (quarter! - 1) * 3 + 1;
      const lastMonth = firstMonth + 2;
      return {
        range: {
          start: toISO(year, firstMonth, 1),
          end: toISO(year, lastMonth, daysInMonth(year, lastMonth)),
        },
        precision: "quarter",
      };
    }
    case "open-start":
      return { range: { start: toISO(year, month!, day!), end: null }, precision: "open_ended" };
  }
}

/** Only `exact` and `week` ranges are precise enough to route around. Anything
 *  coarser warns instead — see DatePrecision. */
export function isHardConflict(precision: DatePrecision): boolean {
  return precision === "exact" || precision === "week";
}

export interface BlockedWindow {
  range: DateRange;
  precision: DatePrecision;
  /** Opaque to this module; echoed back on conflicts so callers can attribute. */
  id: string;
  label?: string;
}

export interface Conflict {
  blocked: BlockedWindow;
  requested: DateRange;
  hard: boolean;
}

/** Which blocked windows collide with a requested range. */
export function findConflicts(requested: DateRange, blocked: BlockedWindow[]): Conflict[] {
  return blocked
    .filter((b) => rangesOverlap(requested, b.range))
    .map((b) => ({ blocked: b, requested, hard: isHardConflict(b.precision) }));
}

/**
 * Nearest window of `lengthDays` that collides with nothing.
 *
 * Searches forward from `earliest` one day at a time and returns the first
 * clear window. Forward-only and greedy on purpose: proposing a date *earlier*
 * than the sponsor asked for is usually not helpful, and "the soonest slot
 * after the conflict" is what a human would offer.
 *
 * Only hard-conflict windows block. A fuzzy commitment shouldn't push a
 * concrete proposal a month down the calendar.
 */
export function findFreeWindow(
  blocked: BlockedWindow[],
  opts: { lengthDays: number; earliest: string; latest: string },
): DateRange | null {
  const hard = blocked.filter((b) => isHardConflict(b.precision));
  let cursor = opts.earliest;
  while (cursor <= opts.latest) {
    const candidate: DateRange = { start: cursor, end: addDays(cursor, opts.lengthDays - 1) };
    if (candidate.end! > opts.latest) return null;
    const hit = hard.find((b) => rangesOverlap(candidate, b.range));
    if (!hit) return candidate;
    // Jump to the day after the colliding window rather than stepping one day
    // at a time — same result, but linear in conflicts instead of in days.
    cursor = hit.range.end ? addDays(hit.range.end, 1) : addDays(cursor, 1);
  }
  return null;
}

/** Human-readable range for prompts and UI: "Mar 3–14, 2026". */
export function formatRange(range: DateRange): string {
  if (!range.start && !range.end) return "no dates";
  if (!range.end) return `from ${range.start}`;
  if (!range.start) return `until ${range.end}`;
  return range.start === range.end ? range.start : `${range.start} → ${range.end}`;
}
