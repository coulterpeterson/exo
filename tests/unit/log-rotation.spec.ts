/**
 * Log file rollover.
 *
 * The bug this covers: the day was resolved once at startup and baked into the
 * destination, so an app left running for three days wrote all three into the
 * file named for the day it launched — and retention, which only ran at
 * startup, stopped applying too.
 *
 * Assertions here are timezone-agnostic on purpose: they check invariants
 * ("the next local midnight", "the same answer from every hour of the day")
 * rather than hardcoded instants, so the suite behaves the same on a
 * developer's machine and in CI's UTC.
 */
import { test, expect } from "@playwright/test";
import { decideRoll, nextLocalMidnight } from "../../src/main/utils/log-rotation";
import { todayISO } from "../../src/main/utils/date-range";

test.describe("nextLocalMidnight", () => {
  test("lands on midnight of the following local day", () => {
    const now = new Date(2026, 7, 17, 14, 32, 11, 500);
    const next = new Date(nextLocalMidnight(now));
    expect(next.getHours()).toBe(0);
    expect(next.getMinutes()).toBe(0);
    expect(next.getSeconds()).toBe(0);
    expect(next.getMilliseconds()).toBe(0);
    expect(next.getDate()).toBe(18);
    expect(next.getMonth()).toBe(7);
  });

  test("is always in the future, even a millisecond before midnight", () => {
    const now = new Date(2026, 7, 17, 23, 59, 59, 999);
    expect(nextLocalMidnight(now)).toBeGreaterThan(now.getTime());
  });

  test("crosses a month end", () => {
    const next = new Date(nextLocalMidnight(new Date(2026, 7, 31, 22, 0)));
    expect(next.getMonth()).toBe(8);
    expect(next.getDate()).toBe(1);
  });

  test("crosses a year end", () => {
    const next = new Date(nextLocalMidnight(new Date(2026, 11, 31, 22, 0)));
    expect(next.getFullYear()).toBe(2027);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(1);
  });

  test("crosses a leap day", () => {
    const next = new Date(nextLocalMidnight(new Date(2028, 1, 28, 22, 0)));
    expect(next.getMonth()).toBe(1);
    expect(next.getDate()).toBe(29);
  });

  test("every hour of a day agrees on the next midnight", () => {
    // Catches "now + 86_400_000", which drifts by an hour across a DST change
    // and would roll the file early or late on those two days a year. March 8
    // is a US spring-forward date; the invariant holds everywhere regardless.
    const expected = nextLocalMidnight(new Date(2026, 2, 8, 0, 30));
    for (let hour = 0; hour < 24; hour++) {
      expect(nextLocalMidnight(new Date(2026, 2, 8, hour, 30))).toBe(expected);
    }
  });
});

test.describe("decideRoll", () => {
  test("does nothing before the deadline", () => {
    const now = new Date(2026, 7, 17, 10, 0);
    const d = decideRoll("2026-08-17", nextLocalMidnight(now), now);
    expect(d.roll).toBe(false);
    expect(d.day).toBe("2026-08-17");
  });

  test("rolls once the date has actually changed", () => {
    const now = new Date(2026, 7, 18, 0, 0, 1);
    const deadline = nextLocalMidnight(new Date(2026, 7, 17, 10, 0));
    const d = decideRoll("2026-08-17", deadline, now);
    expect(d.roll).toBe(true);
    expect(d.day).toBe("2026-08-18");
    expect(d.nextCheckAt).toBe(nextLocalMidnight(now));
  });

  test("a passed deadline on the same date advances without reopening the file", () => {
    // A clock correction or a DST shift can push past the deadline while the
    // calendar day is unchanged. Reopening would truncate nothing but would
    // churn the file descriptor and re-run retention for no reason.
    const now = new Date(2026, 7, 17, 10, 0);
    const d = decideRoll("2026-08-17", now.getTime() - 1000, now);
    expect(d.roll).toBe(false);
    expect(d.day).toBe("2026-08-17");
    expect(d.nextCheckAt).toBe(nextLocalMidnight(now));
  });

  test("catches up after the machine slept through midnight", () => {
    // Waking two days later must still swap the file, and must land on today
    // rather than the day the deadline belonged to.
    const now = new Date(2026, 7, 19, 9, 0);
    const deadline = nextLocalMidnight(new Date(2026, 7, 17, 10, 0));
    const d = decideRoll("2026-08-17", deadline, now);
    expect(d.roll).toBe(true);
    expect(d.day).toBe("2026-08-19");
  });

  test("the day stamp matches the filename helper", () => {
    // The stamp names the file, so it has to agree with todayISO — which is
    // local, unlike the toISOString().split("T") this replaced.
    const now = new Date(2026, 0, 5, 23, 30);
    const d = decideRoll("2026-01-04", now.getTime() - 1, now);
    expect(d.day).toBe(todayISO(now));
    expect(d.day).toBe("2026-01-05");
  });
});
