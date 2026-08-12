/**
 * Date arithmetic for commitment tracking.
 *
 * These carry more weight than usual: the module exists specifically so this
 * logic is testable (everything downstream imports Electron and can't be), and
 * a wrong answer here silently mis-books a real sponsor window.
 */
import { test, expect } from "@playwright/test";
import {
  addDays,
  daysBetween,
  daysInMonth,
  expandFuzzyRange,
  findConflicts,
  findFreeWindow,
  formatRange,
  isHardConflict,
  isIsoDate,
  rangesOverlap,
  resolveYear,
  todayISO,
  type BlockedWindow,
} from "../../src/main/utils/date-range";

const win = (id: string, start: string | null, end: string | null, precision = "exact" as const) =>
  ({ id, range: { start, end }, precision }) as BlockedWindow;

test.describe("rangesOverlap", () => {
  test("detects a plain overlap", () => {
    expect(
      rangesOverlap(
        { start: "2026-03-01", end: "2026-03-10" },
        { start: "2026-03-05", end: "2026-03-15" },
      ),
    ).toBe(true);
  });

  test("ends are inclusive, so ranges sharing one day collide", () => {
    expect(
      rangesOverlap(
        { start: "2026-03-01", end: "2026-03-03" },
        { start: "2026-03-03", end: "2026-03-06" },
      ),
    ).toBe(true);
  });

  test("adjacent ranges do not collide", () => {
    // Mar 1-3 then Mar 4-6 — a video finishing Tuesday and another starting
    // Wednesday is not a conflict.
    expect(
      rangesOverlap(
        { start: "2026-03-01", end: "2026-03-03" },
        { start: "2026-03-04", end: "2026-03-06" },
      ),
    ).toBe(false);
  });

  test("open start extends backwards forever", () => {
    expect(
      rangesOverlap({ start: null, end: "2026-03-10" }, { start: "1999-01-01", end: "1999-01-02" }),
    ).toBe(true);
  });

  test("open end extends forwards forever", () => {
    expect(
      rangesOverlap({ start: "2026-03-01", end: null }, { start: "2099-12-31", end: "2099-12-31" }),
    ).toBe(true);
  });

  test("two fully open ranges always collide", () => {
    expect(rangesOverlap({ start: null, end: null }, { start: null, end: null })).toBe(true);
  });

  test("compares correctly across a year boundary", () => {
    expect(
      rangesOverlap(
        { start: "2026-12-28", end: "2027-01-04" },
        { start: "2027-01-01", end: "2027-01-02" },
      ),
    ).toBe(true);
    expect(
      rangesOverlap(
        { start: "2026-12-28", end: "2026-12-31" },
        { start: "2027-01-01", end: "2027-01-02" },
      ),
    ).toBe(false);
  });
});

test.describe("day arithmetic", () => {
  test("addDays crosses month and year boundaries", () => {
    expect(addDays("2026-03-30", 3)).toBe("2026-04-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-05", -6)).toBe("2026-02-27");
  });

  test("addDays is unaffected by DST transitions", () => {
    // US DST starts 2026-03-08 and ends 2026-11-01. A UTC-based
    // implementation drifts a day here; a local-parts one does not.
    expect(addDays("2026-03-07", 2)).toBe("2026-03-09");
    expect(addDays("2026-10-31", 2)).toBe("2026-11-02");
  });

  test("daysBetween is inclusive and DST-safe", () => {
    expect(daysBetween("2026-03-03", "2026-03-03")).toBe(1);
    expect(daysBetween("2026-03-03", "2026-03-14")).toBe(12);
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(3);
    expect(daysBetween("2026-10-31", "2026-11-02")).toBe(3);
  });

  test("daysInMonth handles February in leap and non-leap years", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
  });

  test("todayISO formats from local parts with zero padding", () => {
    expect(todayISO(new Date(2026, 2, 3))).toBe("2026-03-03");
    // 23:30 local on the 3rd is still the 3rd — a UTC-based implementation
    // would report the 4th for anyone east of Greenwich.
    expect(todayISO(new Date(2026, 0, 9, 23, 30))).toBe("2026-01-09");
  });

  test("isIsoDate rejects junk", () => {
    expect(isIsoDate("2026-03-03")).toBe(true);
    expect(isIsoDate("2026-3-3")).toBe(false);
    expect(isIsoDate("March 3")).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });
});

test.describe("resolveYear", () => {
  test("uses the send year for a date near the send date", () => {
    expect(resolveYear(3, 14, "2026-03-01")).toBe("2026-03-14");
  });

  test("rolls forward when the date is long past at send time", () => {
    // Sent in December talking about "Mar 3" — they mean next March.
    expect(resolveYear(3, 3, "2026-12-10")).toBe("2027-03-03");
  });

  test("stays in the send year just inside the grace window", () => {
    // Sent Apr 1 referring to "Mar 3" — a window that just started, not one a
    // year away.
    expect(resolveYear(3, 3, "2026-04-01")).toBe("2026-03-03");
  });

  test("clamps Feb 29 to a valid day in a non-leap year", () => {
    expect(resolveYear(2, 29, "2026-02-01")).toBe("2026-02-28");
  });
});

test.describe("expandFuzzyRange", () => {
  test("exact single day", () => {
    const r = expandFuzzyRange("exact", { year: 2026, month: 3, day: 3 });
    expect(r.range).toEqual({ start: "2026-03-03", end: "2026-03-03" });
    expect(r.precision).toBe("exact");
  });

  test("week of the 3rd is seven inclusive days", () => {
    const r = expandFuzzyRange("week-of", { year: 2026, month: 3, day: 3 });
    expect(r.range).toEqual({ start: "2026-03-03", end: "2026-03-09" });
    expect(r.precision).toBe("week");
  });

  test("early / mid / late split the month", () => {
    expect(expandFuzzyRange("early", { year: 2026, month: 3 }).range).toEqual({
      start: "2026-03-01",
      end: "2026-03-10",
    });
    expect(expandFuzzyRange("mid", { year: 2026, month: 3 }).range).toEqual({
      start: "2026-03-11",
      end: "2026-03-20",
    });
    expect(expandFuzzyRange("late", { year: 2026, month: 3 }).range).toEqual({
      start: "2026-03-21",
      end: "2026-03-31",
    });
  });

  test("late February respects month length", () => {
    expect(expandFuzzyRange("late", { year: 2026, month: 2 }).range.end).toBe("2026-02-28");
    expect(expandFuzzyRange("late", { year: 2028, month: 2 }).range.end).toBe("2028-02-29");
  });

  test("whole month and quarter", () => {
    expect(expandFuzzyRange("month", { year: 2026, month: 3 }).range).toEqual({
      start: "2026-03-01",
      end: "2026-03-31",
    });
    const q = expandFuzzyRange("quarter", { year: 2026, quarter: 2 });
    expect(q.range).toEqual({ start: "2026-04-01", end: "2026-06-30" });
    expect(q.precision).toBe("quarter");
  });

  test("open start leaves the end null", () => {
    const r = expandFuzzyRange("open-start", { year: 2026, month: 3, day: 3 });
    expect(r.range).toEqual({ start: "2026-03-03", end: null });
    expect(r.precision).toBe("open_ended");
  });

  test("only exact and week are hard conflicts", () => {
    // A month-precision commitment must warn, never silently block all of March.
    expect(isHardConflict("exact")).toBe(true);
    expect(isHardConflict("week")).toBe(true);
    expect(isHardConflict("month")).toBe(false);
    expect(isHardConflict("quarter")).toBe(false);
    expect(isHardConflict("open_ended")).toBe(false);
    expect(isHardConflict("none")).toBe(false);
  });
});

test.describe("findConflicts", () => {
  const blocked = [
    win("emma", "2026-03-03", "2026-03-14"),
    win("vague", "2026-05-01", "2026-05-31", "month"),
  ];

  test("finds an overlapping hard commitment", () => {
    const hits = findConflicts({ start: "2026-03-10", end: "2026-03-20" }, blocked);
    expect(hits).toHaveLength(1);
    expect(hits[0].blocked.id).toBe("emma");
    expect(hits[0].hard).toBe(true);
  });

  test("reports a fuzzy overlap as a soft conflict", () => {
    const hits = findConflicts({ start: "2026-05-10", end: "2026-05-12" }, blocked);
    expect(hits).toHaveLength(1);
    expect(hits[0].hard).toBe(false);
  });

  test("returns nothing for a clear window", () => {
    expect(findConflicts({ start: "2026-04-01", end: "2026-04-10" }, blocked)).toEqual([]);
  });
});

test.describe("findFreeWindow", () => {
  test("returns the requested window when nothing blocks it", () => {
    expect(
      findFreeWindow([], { lengthDays: 5, earliest: "2026-03-01", latest: "2026-12-31" }),
    ).toEqual({
      start: "2026-03-01",
      end: "2026-03-05",
    });
  });

  test("skips past a blocking window to the next clear day", () => {
    const got = findFreeWindow([win("emma", "2026-03-03", "2026-03-14")], {
      lengthDays: 12,
      earliest: "2026-03-03",
      latest: "2026-12-31",
    });
    expect(got).toEqual({ start: "2026-03-15", end: "2026-03-26" });
  });

  test("fits a short window into a gap between two commitments", () => {
    const got = findFreeWindow(
      [win("a", "2026-03-01", "2026-03-10"), win("b", "2026-03-15", "2026-03-31")],
      { lengthDays: 3, earliest: "2026-03-01", latest: "2026-12-31" },
    );
    expect(got).toEqual({ start: "2026-03-11", end: "2026-03-13" });
  });

  test("returns null when nothing fits before the horizon", () => {
    const got = findFreeWindow([win("a", "2026-03-01", "2026-03-31")], {
      lengthDays: 5,
      earliest: "2026-03-01",
      latest: "2026-03-31",
    });
    expect(got).toBeNull();
  });

  test("fuzzy commitments do not push the proposal out", () => {
    // A month-precision block must not shove a concrete proposal into April.
    const got = findFreeWindow([win("vague", "2026-03-01", "2026-03-31", "month")], {
      lengthDays: 3,
      earliest: "2026-03-05",
      latest: "2026-12-31",
    });
    expect(got).toEqual({ start: "2026-03-05", end: "2026-03-07" });
  });

  test("an open-ended commitment blocks everything after its start", () => {
    const got = findFreeWindow([win("forever", "2026-03-01", null)], {
      lengthDays: 3,
      earliest: "2026-03-01",
      latest: "2026-06-30",
    });
    expect(got).toBeNull();
  });
});

test.describe("formatRange", () => {
  test("renders each shape", () => {
    expect(formatRange({ start: "2026-03-03", end: "2026-03-14" })).toBe("2026-03-03 → 2026-03-14");
    expect(formatRange({ start: "2026-03-03", end: "2026-03-03" })).toBe("2026-03-03");
    expect(formatRange({ start: "2026-03-03", end: null })).toBe("from 2026-03-03");
    expect(formatRange({ start: null, end: "2026-03-03" })).toBe("until 2026-03-03");
    expect(formatRange({ start: null, end: null })).toBe("no dates");
  });
});
