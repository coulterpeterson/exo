/**
 * Prose date scanning.
 *
 * The stakes are asymmetric and the module is tuned accordingly: a missed date
 * costs a warning we didn't raise, but an invented one downgrades an honest
 * "avoided Mar 3-14" card to "flagged" for no reason. These tests pin both the
 * shapes we do handle and the near-misses we deliberately don't.
 */
import { test, expect } from "@playwright/test";
import {
  findDateRangesInText,
  looksDateish,
  textMentionsRange,
} from "../../src/main/utils/date-text";

const REF = "2026-02-01";
const find = (t: string) => findDateRangesInText(t, REF);

test.describe("looksDateish", () => {
  test("accepts month names, slashes, week-of and quarters", () => {
    expect(looksDateish("how about March?")).toBe(true);
    expect(looksDateish("does 3/14 work")).toBe(true);
    expect(looksDateish("the week of the 3rd")).toBe(true);
    expect(looksDateish("sometime in Q2")).toBe(true);
  });

  test("rejects text with no date signal", () => {
    expect(looksDateish("thanks, sounds good, send the brief over")).toBe(false);
  });
});

test.describe("findDateRangesInText", () => {
  test("same-month range with a hyphen", () => {
    expect(find("we'd run it March 3-14 if that works")).toEqual([
      { start: "2026-03-03", end: "2026-03-14" },
    ]);
  });

  test("en dash and 'to' are equivalent", () => {
    expect(find("Mar 3 – 14")).toEqual([{ start: "2026-03-03", end: "2026-03-14" }]);
    expect(find("March 3 to 14")).toEqual([{ start: "2026-03-03", end: "2026-03-14" }]);
    expect(find("March 3 through 14")).toEqual([{ start: "2026-03-03", end: "2026-03-14" }]);
  });

  test("explicit year overrides the reference year", () => {
    expect(find("March 3-14, 2027")).toEqual([{ start: "2027-03-03", end: "2027-03-14" }]);
  });

  test("cross-month range", () => {
    expect(find("March 28 - April 4")).toEqual([{ start: "2026-03-28", end: "2026-04-04" }]);
  });

  test("cross-year range anchors the end to the start", () => {
    // Sent in Feb, so "Dec 28 - Jan 4" runs into the following year.
    expect(findDateRangesInText("Dec 28 - Jan 4", "2026-02-01")).toEqual([
      { start: "2026-12-28", end: "2027-01-04" },
    ]);
  });

  test("week of a date becomes seven inclusive days", () => {
    expect(find("the week of March 3")).toEqual([{ start: "2026-03-03", end: "2026-03-09" }]);
  });

  test("a single date becomes a one-day range", () => {
    expect(find("let's publish March 3")).toEqual([{ start: "2026-03-03", end: "2026-03-03" }]);
  });

  test("a range is not also counted as its start date", () => {
    // "Mar 3-14" must not additionally register a bare "Mar 3".
    expect(find("Mar 3-14")).toHaveLength(1);
  });

  test("week-of is not also counted as a single date", () => {
    expect(find("week of March 3")).toHaveLength(1);
  });

  test("numeric ranges", () => {
    expect(find("3/14 - 3/20")).toEqual([{ start: "2026-03-14", end: "2026-03-20" }]);
  });

  test("clamps an impossible day to the end of the month", () => {
    expect(find("Feb 3-31")).toEqual([{ start: "2026-02-03", end: "2026-02-28" }]);
  });

  test("ignores a backwards range rather than inventing one", () => {
    expect(find("March 14-3")).toEqual([]);
  });

  test("finds nothing in dateless prose", () => {
    expect(find("happy to do it, send the contract over")).toEqual([]);
  });

  test("deduplicates a date mentioned twice", () => {
    expect(find("March 3-14 works. Confirming March 3-14.")).toHaveLength(1);
  });

  test("picks up multiple distinct ranges", () => {
    const got = find("either March 3-14 or April 6-17");
    expect(got).toEqual([
      { start: "2026-03-03", end: "2026-03-14" },
      { start: "2026-04-06", end: "2026-04-17" },
    ]);
  });
});

test.describe("textMentionsRange", () => {
  const blocked = { start: "2026-03-03", end: "2026-03-14" };

  test("detects a draft that offered the blocked window anyway", () => {
    expect(textMentionsRange("Mar 3-14 works great!", blocked, REF)).toBe(true);
  });

  test("detects a partial overlap", () => {
    expect(textMentionsRange("how about March 10-20?", blocked, REF)).toBe(true);
  });

  test("passes a draft that proposed a clear window", () => {
    expect(textMentionsRange("how about March 17-28?", blocked, REF)).toBe(false);
  });

  test("adjacent is not overlapping", () => {
    expect(textMentionsRange("March 15-20 then", blocked, REF)).toBe(false);
  });
});
