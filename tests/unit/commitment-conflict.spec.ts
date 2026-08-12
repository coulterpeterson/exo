/**
 * Conflict planning and the honesty guard.
 *
 * The load-bearing property here is that "avoided" is only ever claimed when it
 * is true. Everything else — the mandate wording, the alternative window — is
 * in service of that.
 */
import { test, expect } from "@playwright/test";
import {
  planConflicts,
  toBlockedWindows,
  verifyConflictsAgainstBody,
} from "../../src/main/utils/commitment-conflict";
import type { Commitment } from "../../src/shared/types";

function make(overrides: Partial<Commitment> = {}): Commitment {
  return {
    id: "emma",
    accountId: "default",
    kind: "date_range",
    status: "active",
    counterpartyEmail: "emma@acme.com",
    counterpartyLabel: "Emma at Acme",
    statement: "sponsored main-channel video",
    startDate: "2026-03-03",
    endDate: "2026-03-14",
    datePrecision: "exact",
    exclusive: true,
    confidence: 1,
    confirmed: true,
    source: "manual",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

test.describe("toBlockedWindows", () => {
  test("only dated exclusive commitments can block", () => {
    const got = toBlockedWindows([
      make(),
      make({ id: "declined", exclusive: false }),
      make({ id: "undated", startDate: null, endDate: null }),
    ]);
    expect(got.map((b) => b.id)).toEqual(["emma"]);
  });
});

test.describe("planConflicts", () => {
  test("no requested dates means nothing to do", () => {
    expect(planConflicts(null, [make()]).conflicts).toEqual([]);
    expect(planConflicts({ start: null, end: null }, [make()]).mandate).toBe("");
  });

  test("a clear window produces no conflict and no mandate", () => {
    const plan = planConflicts({ start: "2026-04-01", end: "2026-04-10" }, [make()]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.mandate).toBe("");
  });

  test("an overlapping request is marked avoided with an alternative", () => {
    const plan = planConflicts({ start: "2026-03-05", end: "2026-03-16" }, [make()]);
    expect(plan.conflicts).toHaveLength(1);
    const c = plan.conflicts[0];
    expect(c.outcome).toBe("avoided");
    expect(c.counterpartyLabel).toBe("Emma at Acme");
    // 12 requested days, so the alternative is the next clear 12-day window.
    expect(c.proposedRange).toEqual({ start: "2026-03-15", end: "2026-03-26" });
  });

  test("the mandate tells the model what to offer and what not to", () => {
    const plan = planConflicts({ start: "2026-03-05", end: "2026-03-16" }, [make()]);
    expect(plan.mandate).toContain("Do NOT offer or agree to");
    expect(plan.mandate).toContain("2026-03-15 → 2026-03-26");
  });

  test("the mandate never leaks who the other sponsor is", () => {
    // Telling Wei that Emma booked the slot would be a real-world disaster.
    const plan = planConflicts({ start: "2026-03-05", end: "2026-03-16" }, [make()]);
    expect(plan.mandate).toContain("Do not name the other party");
  });

  test("a fuzzy commitment flags rather than moves the date", () => {
    const plan = planConflicts({ start: "2026-03-05", end: "2026-03-08" }, [
      make({ datePrecision: "month", startDate: "2026-03-01", endDate: "2026-03-31" }),
    ]);
    expect(plan.conflicts[0].outcome).toBe("flagged");
    expect(plan.conflicts[0].proposedRange).toBeNull();
    expect(plan.mandate).toContain("Do not hard-commit");
  });

  test("carries the unconfirmed flag through to the record and the mandate", () => {
    const plan = planConflicts({ start: "2026-03-05", end: "2026-03-16" }, [
      make({ confidence: 0.4, confirmed: false, source: "sent-extractor" }),
    ]);
    expect(plan.conflicts[0].unconfirmed).toBe(true);
    expect(plan.mandate).toContain("unconfirmed");
  });

  test("falls back to asking for other timing when nothing is free", () => {
    const plan = planConflicts({ start: "2026-03-05", end: "2026-03-16" }, [
      make({ startDate: "2026-01-01", endDate: "2027-12-31" }),
    ]);
    expect(plan.conflicts[0].proposedRange).toBeNull();
    expect(plan.mandate).toContain("ask what other timing would work");
  });

  test("reports every colliding commitment, not just the first", () => {
    const plan = planConflicts({ start: "2026-03-05", end: "2026-03-25" }, [
      make(),
      make({
        id: "dana",
        counterpartyLabel: "Dana at Bolt",
        startDate: "2026-03-20",
        endDate: "2026-03-28",
      }),
    ]);
    expect(plan.conflicts.map((c) => c.commitmentId).sort()).toEqual(["dana", "emma"]);
  });

  test("a non-exclusive commitment never blocks", () => {
    const plan = planConflicts({ start: "2026-03-05", end: "2026-03-16" }, [
      make({ exclusive: false }),
    ]);
    expect(plan.conflicts).toEqual([]);
  });
});

test.describe("verifyConflictsAgainstBody", () => {
  const plan = () => planConflicts({ start: "2026-03-05", end: "2026-03-16" }, [make()]).conflicts;

  test("leaves an honest avoidance alone", () => {
    const got = verifyConflictsAgainstBody(plan(), () => false);
    expect(got[0].outcome).toBe("avoided");
  });

  test("downgrades when the draft still mentions the blocked window", () => {
    // The exact failure this guard exists for: card says avoided, body says
    // "Mar 3-14 works great!".
    const got = verifyConflictsAgainstBody(plan(), () => true);
    expect(got[0].outcome).toBe("flagged");
    expect(got[0].proposedRange).toBeNull();
    expect(got[0].reason).toContain("not avoided");
  });

  test("does not touch entries already flagged", () => {
    const soft = planConflicts({ start: "2026-03-05", end: "2026-03-08" }, [
      make({ datePrecision: "month", startDate: "2026-03-01", endDate: "2026-03-31" }),
    ]).conflicts;
    const got = verifyConflictsAgainstBody(soft, () => true);
    expect(got[0].outcome).toBe("flagged");
    expect(got[0].reason).not.toContain("not avoided");
  });
});
