/**
 * The two pure gates around automatic extraction: what's worth an LLM call,
 * and what to do with the result.
 *
 * Reconciliation is where the expensive mistakes live — a wrong supersede
 * silently rewrites the record of what was agreed — so the rules are pinned
 * explicitly rather than left to inspection.
 */
import { test, expect } from "@playwright/test";
import { shouldExtractCommitments } from "../../src/main/utils/commitment-prefilter";
import { reconcileCommitment } from "../../src/main/utils/commitment-reconcile";
import type { Commitment } from "../../src/shared/types";

function make(overrides: Partial<Commitment> = {}): Commitment {
  return {
    id: "new",
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
    confidence: 0.9,
    confirmed: false,
    source: "sent-extractor",
    sourceSentAt: 2000,
    createdAt: 2000,
    updatedAt: 2000,
    ...overrides,
  };
}

const LONG_DEAL_EMAIL =
  "Hi Emma — confirming we're good to go on the sponsored video. We'll run the integration March 3-14 and I'll send the draft cut a week before. Rate is as per the rate card we discussed.";

test.describe("shouldExtractCommitments", () => {
  test("accepts a real deal email", () => {
    expect(shouldExtractCommitments(LONG_DEAL_EMAIL).worthExtracting).toBe(true);
  });

  test("skips short bodies", () => {
    expect(
      shouldExtractCommitments("confirmed for the sponsored video March 3-14").worthExtracting,
    ).toBe(false);
  });

  test("skips chatter with no deal vocabulary", () => {
    const text =
      "Thanks so much for the kind words about the last upload, really appreciate you saying that. " +
      "I'll be around most of March if you want to catch up properly at some point.";
    expect(shouldExtractCommitments(text).worthExtracting).toBe(false);
  });

  test("skips deal talk with no dates and nothing committal", () => {
    const text =
      "Here's my rate card for sponsorship and brand integration work, covering the main channel " +
      "and shorts. Let me know if you have questions about any of the deliverables listed there.";
    expect(shouldExtractCommitments(text).worthExtracting).toBe(false);
  });

  test("accepts a settled scope with no date and no committal verb", () => {
    // The gap this closes: choosing a deliverable commits the user to something
    // real, but contains neither a date nor any of the committal vocabulary.
    const text =
      "Thanks for reaching out! For this collaboration, I think the 60-90 second integration " +
      "would be the better fit for my content style and audience rather than a dedicated review.";
    expect(shouldExtractCommitments(text).worthExtracting).toBe(true);
  });

  test("accepts work described as already delivered", () => {
    const text =
      "Just flagging that we already wrapped up a paid collaboration on the S9 Pro with Tutu. " +
      "That sponsorship video went live and the final payment came through, so we're all square.";
    expect(shouldExtractCommitments(text).worthExtracting).toBe(true);
  });

  test("still skips a question about scope, which settles nothing", () => {
    const text =
      "Here's my rate card for sponsorship and brand integration work across the main channel. " +
      "Which of the deliverables listed there were you thinking about for this campaign?";
    expect(shouldExtractCommitments(text).worthExtracting).toBe(false);
  });

  test("accepts committal deal language even with no dates", () => {
    const text =
      "Hi Wei — I'm going to pass on this sponsorship, the budget is below my rate card for a " +
      "dedicated integration. Happy to revisit if the campaign budget changes later on.";
    expect(shouldExtractCommitments(text).worthExtracting).toBe(true);
  });

  test("skips auto-replies", () => {
    const text = `Automatic reply: I am out of the office until March 3. ${LONG_DEAL_EMAIL}`;
    expect(shouldExtractCommitments(text).worthExtracting).toBe(false);
  });

  test("skips notes to self", () => {
    const got = shouldExtractCommitments(LONG_DEAL_EMAIL, {
      toAddresses: ["me@example.com"],
      userEmail: "me@example.com",
    });
    expect(got.worthExtracting).toBe(false);
  });
});

test.describe("reconcileCommitment", () => {
  test("inserts when there is nothing related", () => {
    expect(reconcileCommitment(make(), []).type).toBe("insert");
  });

  test("skips an exact duplicate", () => {
    const existing = make({ id: "old", sourceSentAt: 1000 });
    expect(reconcileCommitment(make(), [existing]).type).toBe("skip");
  });

  test("supersedes when the same deal moved dates", () => {
    const existing = make({ id: "old", sourceSentAt: 1000 });
    const moved = make({ startDate: "2026-03-10", endDate: "2026-03-21" });
    const action = reconcileCommitment(moved, [existing]);
    expect(action).toEqual({ type: "supersede", existingId: "old", candidate: moved });
  });

  test("does not supersede a different counterparty", () => {
    const existing = make({ id: "old", counterpartyEmail: "dana@bolt.io", sourceSentAt: 1000 });
    expect(reconcileCommitment(make(), [existing]).type).toBe("insert");
  });

  test("same domain is not the same counterparty", () => {
    // Two people at one agency can hold genuinely separate deals.
    const existing = make({
      id: "old",
      counterpartyEmail: "other@acme.com",
      counterpartyLabel: "Other at Acme",
      sourceSentAt: 1000,
    });
    expect(reconcileCommitment(make(), [existing]).type).toBe("insert");
  });

  test("does not supersede a non-overlapping window", () => {
    const existing = make({
      id: "old",
      startDate: "2026-06-01",
      endDate: "2026-06-10",
      sourceSentAt: 1000,
    });
    expect(reconcileCommitment(make(), [existing]).type).toBe("insert");
  });

  test("never lets an unconfirmed extraction overwrite a confirmed row", () => {
    // The worst failure mode in the system: silently rewriting a human edit.
    const existing = make({ id: "old", confirmed: true, source: "manual", sourceSentAt: 1000 });
    const action = reconcileCommitment(make({ startDate: "2026-03-10" }), [existing]);
    expect(action.type).toBe("insert");
  });

  test("a confirmed correction may supersede an unconfirmed row", () => {
    const existing = make({ id: "old", confirmed: false, sourceSentAt: 1000 });
    const action = reconcileCommitment(
      make({ confirmed: true, source: "manual", startDate: "2026-03-10" }),
      [existing],
    );
    expect(action.type).toBe("supersede");
  });

  test("an older email never overwrites a newer record", () => {
    // Backfill and out-of-order sync must not rewind state.
    const existing = make({ id: "old", sourceSentAt: 5000 });
    const stale = make({ startDate: "2026-03-10", sourceSentAt: 1000 });
    expect(reconcileCommitment(stale, [existing]).type).toBe("skip");
  });

  test("a cancellation retires the matching window", () => {
    const existing = make({ id: "old", sourceSentAt: 1000 });
    const cancel = make({ status: "cancelled" });
    expect(reconcileCommitment(cancel, [existing])).toEqual({ type: "cancel", existingId: "old" });
  });

  test("a cancellation with nothing to cancel is a no-op", () => {
    expect(reconcileCommitment(make({ status: "cancelled" }), []).type).toBe("skip");
  });

  test("different kinds do not supersede each other", () => {
    // A declined deal and a booked window can coexist for the same sponsor.
    const existing = make({
      id: "old",
      kind: "deal_declined",
      exclusive: false,
      sourceSentAt: 1000,
    });
    expect(reconcileCommitment(make(), [existing]).type).toBe("insert");
  });

  test("different subject matter does not supersede", () => {
    const existing = make({ id: "old", subjectMatter: "main channel", sourceSentAt: 1000 });
    const other = make({ subjectMatter: "shorts channel", startDate: "2026-03-10" });
    expect(reconcileCommitment(other, [existing]).type).toBe("insert");
  });
});
