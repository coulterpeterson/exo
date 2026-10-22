/**
 * "Move to Priority" rule building (src/main/services/priority-rules.ts).
 *
 * The user chooses how far a correction should reach; these tests pin that
 * the saved analysis memory reaches exactly that far — no further (a sender
 * rule mustn't become global) and no less (a type rule mustn't be tied to the
 * one sender it was made on).
 */
import { test, expect } from "@playwright/test";
import {
  buildPriorityRuleMemories,
  isDuplicateRule,
  senderAddress,
} from "../../src/main/services/priority-rules";

const NOW = 1_800_000_000_000;
let n = 0;
const id = () => `m${++n}`;

const garry = { accountId: "default", from: "Garry Tan <Garry.Tan@TechCorp.com>" };
const product = { accountId: "default", from: "product@acmecorp.com" };
const workMail = { accountId: "work", from: "Ops <ops@work.example>" };

test.describe("senderAddress", () => {
  test("extracts and lowercases an angle-bracketed address", () => {
    expect(senderAddress("Garry Tan <Garry.Tan@TechCorp.com>")).toBe("garry.tan@techcorp.com");
  });

  test("handles a bare address", () => {
    expect(senderAddress("Product@AcmeCorp.com")).toBe("product@acmecorp.com");
  });

  test("handles a quoted display name containing a comma", () => {
    expect(senderAddress('"Tan, Garry" <garry@x.com>')).toBe("garry@x.com");
  });
});

test.describe("buildPriorityRuleMemories", () => {
  test("'just this email' learns nothing", () => {
    expect(buildPriorityRuleMemories({ kind: "none" }, [garry], id, NOW)).toEqual([]);
  });

  test("a sender rule is person-scoped to that sender's address", () => {
    const [memory] = buildPriorityRuleMemories({ kind: "sender" }, [garry], id, NOW);
    expect(memory).toMatchObject({
      accountId: "default",
      scope: "person",
      scopeValue: "garry.tan@techcorp.com",
      memoryType: "analysis",
      source: "priority-override",
      enabled: true,
      createdAt: NOW,
    });
    expect(memory.content).toMatch(/Priority/);
  });

  test("a sender rule across several emails is refused rather than guessed", () => {
    expect(buildPriorityRuleMemories({ kind: "sender" }, [garry, product], id, NOW)).toEqual([]);
  });

  test("a type rule is category-scoped with the user's words as its label", () => {
    const [memory] = buildPriorityRuleMemories(
      { kind: "type", description: "  sponsorship offers from brands  " },
      [garry, product],
      id,
      NOW,
    );
    expect(memory.scope).toBe("category");
    expect(memory.scopeValue).toBe("sponsorship offers from brands");
    expect(memory.content).toBe(
      "Always classify as Priority (needs a reply): sponsorship offers from brands",
    );
  });

  test("a type rule over one account's emails is saved once, not per email", () => {
    const memories = buildPriorityRuleMemories(
      { kind: "type", description: "invoices" },
      [garry, product],
      id,
      NOW,
    );
    expect(memories).toHaveLength(1);
  });

  test("a type rule spanning accounts is saved once per account", () => {
    const memories = buildPriorityRuleMemories(
      { kind: "type", description: "invoices" },
      [garry, workMail, product],
      id,
      NOW,
    );
    expect(memories.map((m) => m.accountId).sort()).toEqual(["default", "work"]);
  });

  test("an email without an account falls back to the default account", () => {
    const [memory] = buildPriorityRuleMemories({ kind: "sender" }, [{ from: "a@b.com" }], id, NOW);
    expect(memory.accountId).toBe("default");
  });

  test("no emails, no rules", () => {
    expect(buildPriorityRuleMemories({ kind: "type", description: "x" }, [], id, NOW)).toEqual([]);
  });
});

test.describe("isDuplicateRule", () => {
  const [rule] = buildPriorityRuleMemories({ kind: "sender" }, [garry], id, NOW);

  test("an identical enabled rule is a duplicate", () => {
    expect(isDuplicateRule(rule, [{ ...rule, id: "other" }])).toBe(true);
  });

  test("matching ignores case and surrounding whitespace", () => {
    const existing = {
      ...rule,
      id: "other",
      scopeValue: "GARRY.TAN@TECHCORP.COM",
      content: `  ${rule.content.toUpperCase()} `,
    };
    expect(isDuplicateRule(rule, [existing])).toBe(true);
  });

  test("a disabled rule doesn't count — the user turned it off, saving again re-enables intent", () => {
    expect(isDuplicateRule(rule, [{ ...rule, id: "other", enabled: false }])).toBe(false);
  });

  test("the same rule for another sender, account or memory type is not a duplicate", () => {
    expect(isDuplicateRule(rule, [{ ...rule, id: "a", scopeValue: "someone@else.com" }])).toBe(
      false,
    );
    expect(isDuplicateRule(rule, [{ ...rule, id: "b", accountId: "work" }])).toBe(false);
    expect(isDuplicateRule(rule, [{ ...rule, id: "c", memoryType: "drafting" }])).toBe(false);
  });
});
