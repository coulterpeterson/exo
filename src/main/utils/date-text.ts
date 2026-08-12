/**
 * Finds date ranges written in prose.
 *
 * Used for two jobs, both of which need to run without an LLM:
 *   1. the prefilter that decides whether an email is worth an extraction call;
 *   2. the verification guard that checks a generated draft didn't propose a
 *      window we told it to avoid — a UI card claiming "avoided Mar 3–14" above
 *      a body offering Mar 3–14 is worse than no card at all.
 *
 * Deliberately conservative: it is better to miss an oddly-phrased date than to
 * invent one, because a false positive here downgrades an honest "avoided" to
 * "flagged" for no reason. All output goes through resolveYear, so a bare
 * "Mar 3" is anchored to the email's own date rather than to today.
 *
 * A near-duplicate exists at extensions/mail-ext-calendar/src/date-extractor.ts.
 * It is not reused: it emits single dates only (no ranges), is wired to nothing
 * but demo data, and its toISODate round-trips through toISOString(), which
 * shifts the day in negative-offset timezones. That is the exact bug this
 * module's string-only arithmetic exists to avoid.
 */
import { addDays, daysInMonth, resolveYear, type DateRange } from "./date-range";

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const MONTH_ALT = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

/** Any date-ish token at all. Cheap gate for the extraction prefilter. */
export function looksDateish(text: string): boolean {
  return (
    new RegExp(`\\b(${MONTH_ALT})\\b`, "i").test(text) ||
    /\b\d{1,2}\/\d{1,2}\b/.test(text) ||
    /\bweek of\b/i.test(text) ||
    /\bQ[1-4]\b/.test(text)
  );
}

function clampDay(year: number, month: number, day: number): number {
  return Math.min(Math.max(day, 1), daysInMonth(year, month));
}

/**
 * Extract every date range the text mentions.
 *
 * @param referenceISO the email's own date, used to resolve a year for
 *   month/day mentions that don't carry one.
 */
export function findDateRangesInText(text: string, referenceISO: string): DateRange[] {
  const found: DateRange[] = [];
  // Character spans already consumed by a range pattern. The single-date pass
  // consults this so "March 28 - April 4" yields one range rather than also
  // re-reporting each endpoint as its own one-day range.
  const claimed: Array<[number, number]> = [];
  const claim = (m: RegExpMatchArray) => {
    if (m.index !== undefined) claimed.push([m.index, m.index + m[0].length]);
  };
  const isClaimed = (at: number) => claimed.some(([s, e]) => at >= s && at < e);
  const push = (start: string, end: string) => {
    if (!found.some((r) => r.start === start && r.end === end)) found.push({ start, end });
  };

  // "week of March 3" / "week of 3/3" → seven days.
  const weekOf = new RegExp(`week of\\s+(?:(${MONTH_ALT})\\.?\\s+)?(\\d{1,2})`, "gi");
  for (const m of text.matchAll(weekOf)) {
    const monthName = m[1]?.toLowerCase();
    if (!monthName) continue;
    claim(m);
    const month = MONTHS[monthName];
    const start = resolveYear(month, Number(m[2]), referenceISO);
    push(start, addDays(start, 6));
  }

  // "March 3 - April 2" (crosses months).
  const crossMonthRange = new RegExp(
    `\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})\\s*(?:-|–|—|to|through|thru)\\s*(${MONTH_ALT})\\.?\\s+(\\d{1,2})`,
    "gi",
  );
  for (const m of text.matchAll(crossMonthRange)) {
    const startIso = resolveYear(MONTHS[m[1].toLowerCase()], Number(m[2]), referenceISO);
    // Anchor the end to the start so a Dec→Jan span lands in the right year.
    const endIso = resolveYear(MONTHS[m[3].toLowerCase()], Number(m[4]), startIso);
    if (endIso < startIso) continue;
    claim(m);
    push(startIso, endIso);
  }

  // "March 3-14", "Mar 3 – 14", "March 3 to 14" (optionally with a year).
  const sameMonthRange = new RegExp(
    `\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})\\s*(?:-|–|—|to|through|thru)\\s*(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?`,
    "gi",
  );
  for (const m of text.matchAll(sameMonthRange)) {
    const month = MONTHS[m[1].toLowerCase()];
    const explicitYear = m[4] ? Number(m[4]) : undefined;
    const startIso = explicitYear
      ? `${explicitYear}-${String(month).padStart(2, "0")}-${String(clampDay(explicitYear, month, Number(m[2]))).padStart(2, "0")}`
      : resolveYear(month, Number(m[2]), referenceISO);
    const year = Number(startIso.slice(0, 4));
    const endDay = clampDay(year, month, Number(m[3]));
    // "Mar 14-3" is not a range; skip rather than invent a backwards one.
    if (endDay < Number(m[2])) continue;
    // A cross-month range already covered these characters.
    if (m.index !== undefined && isClaimed(m.index)) continue;
    claim(m);
    push(startIso, `${year}-${String(month).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`);
  }

  // Numeric "3/14" or "3/14/2026", and numeric ranges "3/14-3/20".
  const numericRange =
    /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(?:-|–|—|to)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/g;
  for (const m of text.matchAll(numericRange)) {
    const startIso = resolveYear(Number(m[1]), Number(m[2]), referenceISO);
    const endIso = resolveYear(Number(m[4]), Number(m[5]), startIso);
    if (endIso < startIso) continue;
    claim(m);
    push(startIso, endIso);
  }

  // Single "March 3" / "March 3, 2026" — only where a range didn't already
  // claim those characters, so "Mar 3-14" doesn't also register as "Mar 3".
  const single = new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?`, "gi");
  for (const m of text.matchAll(single)) {
    if (m.index !== undefined && isClaimed(m.index)) continue;
    // A trailing "- 14" means a range pattern should have owned this; if one
    // didn't match (e.g. a backwards range we rejected) don't half-report it.
    const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 12);
    if (/^\s*(?:-|–|—|to|through|thru)\s*\d/i.test(after)) continue;
    const month = MONTHS[m[1].toLowerCase()];
    const iso = m[3]
      ? `${m[3]}-${String(month).padStart(2, "0")}-${String(clampDay(Number(m[3]), month, Number(m[2]))).padStart(2, "0")}`
      : resolveYear(month, Number(m[2]), referenceISO);
    push(iso, iso);
  }

  return found;
}

/** Does the text mention any date inside `range`? Used by the verification
 *  guard to catch a draft that ignored the avoid-this instruction. */
export function textMentionsRange(text: string, range: DateRange, referenceISO: string): boolean {
  const start = range.start ?? "0000-01-01";
  const end = range.end ?? "9999-12-31";
  return findDateRangesInText(text, referenceISO).some(
    (r) => (r.start ?? "0000-01-01") <= end && start <= (r.end ?? "9999-12-31"),
  );
}
