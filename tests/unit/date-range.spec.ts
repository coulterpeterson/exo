import { test, expect } from "@playwright/test";
import { todayISO } from "../../src/main/utils/date-range";

test.describe("todayISO", () => {
  test("formats from local parts with zero padding", () => {
    expect(todayISO(new Date(2026, 2, 3))).toBe("2026-03-03");
    // 23:30 local on the 9th is still the 9th — a UTC-based implementation
    // would report the 10th for anyone east of Greenwich.
    expect(todayISO(new Date(2026, 0, 9, 23, 30))).toBe("2026-01-09");
  });
});
