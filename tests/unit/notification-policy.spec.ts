/**
 * Which arrivals get announced (src/main/services/notification-policy.ts).
 *
 * The interesting cases are all about NOT announcing: the backlog pulled down
 * at launch, mail a resync re-delivers, mail read in Gmail while the analyzer
 * was still thinking. A mail client that cries wolf gets muted.
 */
import { test, expect } from "@playwright/test";
import {
  NotificationPolicy,
  planBatch,
  displayName,
  PENDING_TTL_MS,
  type ArrivedEmail,
} from "../../src/main/services/notification-policy";

const NOW = 1_700_000_000_000;

function email(over: Partial<ArrivedEmail> = {}): ArrivedEmail {
  return {
    id: "m1",
    threadId: "t1",
    accountId: "default",
    from: "Jody Fabros <jody@thoughtleaders.io>",
    subject: "Sponsorship for Q4",
    labelIds: ["INBOX", "UNREAD"],
    ...over,
  };
}

/** A policy already past its first sync cycle. */
function primed(): NotificationPolicy {
  const policy = new NotificationPolicy();
  policy.markPrimed("default");
  return policy;
}

test.describe("priming", () => {
  test("announces nothing before the account's first sync cycle completes", () => {
    const policy = new NotificationPolicy();
    expect(policy.admit("default", [email()], "all", NOW)).toEqual([]);
  });

  test("the launch backlog is never announced later either", () => {
    const policy = new NotificationPolicy();
    policy.admit("default", [email()], "all", NOW);
    policy.markPrimed("default");
    // Same message redelivered by a resync — it is not news.
    expect(policy.admit("default", [email()], "all", NOW + 1000)).toEqual([]);
  });

  test("markPrimed reports only the first transition", () => {
    const policy = new NotificationPolicy();
    expect(policy.markPrimed("default")).toBe(true);
    expect(policy.markPrimed("default")).toBe(false);
  });

  test("priming is per account", () => {
    const policy = primed();
    expect(policy.admit("other", [email({ id: "m9" })], "all", NOW)).toEqual([]);
    expect(policy.admit("default", [email({ id: "m8" })], "all", NOW)).toHaveLength(1);
  });

  test("forgetting an account makes it prime again", () => {
    const policy = primed();
    policy.forgetAccount("default");
    expect(policy.admit("default", [email()], "all", NOW)).toEqual([]);
  });
});

test.describe("what counts as an arrival", () => {
  test("announces unread inbox mail in 'all' scope", () => {
    const [candidate] = primed().admit("default", [email()], "all", NOW);
    expect(candidate).toMatchObject({
      emailId: "m1",
      threadId: "t1",
      accountId: "default",
      subject: "Sponsorship for Q4",
    });
  });

  test("ignores mail that is already read", () => {
    expect(primed().admit("default", [email({ labelIds: ["INBOX"] })], "all", NOW)).toEqual([]);
  });

  test("ignores mail outside the inbox", () => {
    expect(
      primed().admit(
        "default",
        [email({ labelIds: ["UNREAD", "CATEGORY_PROMOTIONS"] })],
        "all",
        NOW,
      ),
    ).toEqual([]);
  });

  test("ignores the user's own sent mail", () => {
    expect(
      primed().admit("default", [email({ labelIds: ["INBOX", "UNREAD", "SENT"] })], "all", NOW),
    ).toEqual([]);
  });

  test("ignores mail with no labels at all", () => {
    expect(primed().admit("default", [email({ labelIds: undefined })], "all", NOW)).toEqual([]);
  });

  test("announces each message only once", () => {
    const policy = primed();
    expect(policy.admit("default", [email()], "all", NOW)).toHaveLength(1);
    expect(policy.admit("default", [email()], "all", NOW + 30_000)).toEqual([]);
  });

  test("falls back to the sync's account when a message carries none", () => {
    const policy = new NotificationPolicy();
    policy.markPrimed("acct-2");
    const [candidate] = policy.admit("acct-2", [email({ accountId: undefined })], "all", NOW);
    expect(candidate.accountId).toBe("acct-2");
  });
});

test.describe("priority scope", () => {
  test("holds unanalyzed mail rather than announcing it", () => {
    const policy = primed();
    expect(policy.admit("default", [email()], "priority", NOW)).toEqual([]);
    expect(policy.pendingCount()).toBe(1);
  });

  test("announces it once the analyzer says it needs a reply", () => {
    const policy = primed();
    policy.admit("default", [email()], "priority", NOW);
    const candidate = policy.resolveAnalysis("m1", true, () => true);
    expect(candidate?.emailId).toBe("m1");
    expect(policy.pendingCount()).toBe(0);
  });

  test("drops it when the analyzer says it doesn't", () => {
    const policy = primed();
    policy.admit("default", [email()], "priority", NOW);
    expect(policy.resolveAnalysis("m1", false, () => true)).toBeNull();
  });

  test("drops it when the user read it in Gmail while we deliberated", () => {
    const policy = primed();
    policy.admit("default", [email()], "priority", NOW);
    expect(policy.resolveAnalysis("m1", true, () => false)).toBeNull();
  });

  test("announces mail that arrived already analyzed as needing a reply", () => {
    const policy = primed();
    const arrived = email({ analysis: { needsReply: true } });
    expect(policy.admit("default", [arrived], "priority", NOW)).toHaveLength(1);
  });

  test("drops mail that arrived already analyzed as not needing one", () => {
    const policy = primed();
    const arrived = email({ analysis: { needsReply: false } });
    expect(policy.admit("default", [arrived], "priority", NOW)).toEqual([]);
    expect(policy.pendingCount()).toBe(0);
  });

  test("a verdict for something never pending is ignored", () => {
    expect(primed().resolveAnalysis("unknown", true, () => true)).toBeNull();
  });

  test("never announces the same mail twice after a verdict", () => {
    const policy = primed();
    policy.admit("default", [email()], "priority", NOW);
    expect(policy.resolveAnalysis("m1", true, () => true)).not.toBeNull();
    expect(policy.admit("default", [email()], "priority", NOW + 1000)).toEqual([]);
  });

  test("abandons a candidate whose verdict never arrives", () => {
    const policy = primed();
    policy.admit("default", [email()], "priority", NOW);
    // A later batch sweeps expired candidates — analysis is off or broken.
    policy.admit("default", [email({ id: "m2" })], "priority", NOW + PENDING_TTL_MS + 1);
    expect(policy.pendingCount()).toBe(1); // only m2 remains
    expect(policy.resolveAnalysis("m1", true, () => true)).toBeNull();
  });

  test("'all' scope announces without waiting on any verdict", () => {
    const policy = primed();
    expect(policy.admit("default", [email()], "all", NOW)).toHaveLength(1);
    expect(policy.pendingCount()).toBe(0);
  });
});

test.describe("planBatch", () => {
  const candidates = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      emailId: `m${i}`,
      threadId: `t${i}`,
      accountId: "default",
      from: `Person ${i} <p${i}@example.com>`,
      subject: `Subject ${i}`,
      queuedAt: NOW,
    }));

  test("nothing to post", () => {
    expect(planBatch([], 3)).toEqual({ kind: "none" });
  });

  test("one notification each up to the cap", () => {
    const plan = planBatch(candidates(3), 3);
    expect(plan.kind).toBe("individual");
    expect(plan.kind === "individual" && plan.items).toHaveLength(3);
  });

  test("a single summary beyond it", () => {
    const plan = planBatch(candidates(7), 3);
    expect(plan).toMatchObject({ kind: "summary", count: 7 });
    expect(plan.kind === "summary" && plan.senders).toEqual(["Person 0", "Person 1", "Person 2"]);
  });

  test("the summary doesn't repeat a sender who wrote twice", () => {
    const batch = candidates(4).map((c) => ({ ...c, from: "Jody <jody@example.com>" }));
    const plan = planBatch(batch, 3);
    expect(plan.kind === "summary" && plan.senders).toEqual(["Jody"]);
  });
});

test.describe("displayName", () => {
  test("prefers the display name", () => {
    expect(displayName("Jody Fabros <jody@thoughtleaders.io>")).toBe("Jody Fabros");
  });

  test("unwraps a quoted name", () => {
    expect(displayName('"Fabros, Jody" <jody@x.com>')).toBe("Fabros, Jody");
  });

  test("falls back to the address", () => {
    expect(displayName("jody@thoughtleaders.io")).toBe("jody@thoughtleaders.io");
  });

  test("handles a bare angle-bracketed address", () => {
    expect(displayName("<jody@x.com>")).toBe("<jody@x.com>");
  });
});
