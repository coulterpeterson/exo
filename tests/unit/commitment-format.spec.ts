/**
 * The commitments prompt block.
 *
 * This wording is what stands between the drafting model and double-booking a
 * sponsor, so the contents are worth pinning: the cross-sender windows must
 * always be present, fuzzy ranges must not read as hard blocks, and a
 * low-confidence extraction must be visibly marked as such.
 */
import { test, expect } from "@playwright/test";
import { formatCommitmentsBlock } from "../../src/main/utils/commitment-format";
import type { Commitment } from "../../src/shared/types";

function make(overrides: Partial<Commitment> = {}): Commitment {
  return {
    id: "c1",
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

const OPTS = { today: "2026-02-01", recipientEmail: "wei@kolect.ai" };

test.describe("formatCommitmentsBlock", () => {
  test("returns empty string when there is nothing to say", () => {
    expect(formatCommitmentsBlock([], OPTS)).toBe("");
  });

  test("includes today's date so relative dates resolve", () => {
    // The drafting model has no reliable notion of "now".
    expect(formatCommitmentsBlock([make()], OPTS)).toContain("Today's date is 2026-02-01");
  });

  test("lists a commitment made to someone other than the recipient", () => {
    // The whole point: drafting to Wei must still see the window promised to Emma.
    const out = formatCommitmentsBlock([make()], OPTS);
    expect(out).toContain("Emma at Acme");
    expect(out).toContain("2026-03-03 → 2026-03-14");
    expect(out).toMatch(/Do NOT offer or agree to any date/);
  });

  test("marks approximate windows so they don't read as hard blocks", () => {
    const out = formatCommitmentsBlock(
      [make({ datePrecision: "month", startDate: "2026-03-01", endDate: "2026-03-31" })],
      OPTS,
    );
    expect(out).toContain("(approximate dates)");
  });

  test("flags an unconfirmed low-confidence extraction", () => {
    const out = formatCommitmentsBlock(
      [make({ confidence: 0.4, confirmed: false, source: "sent-extractor" })],
      OPTS,
    );
    expect(out).toContain("unconfirmed");
  });

  test("does not flag a low-confidence row the user confirmed", () => {
    const out = formatCommitmentsBlock([make({ confidence: 0.4, confirmed: true })], OPTS);
    expect(out).not.toContain("unconfirmed");
  });

  test("separates non-date facts about the recipient", () => {
    const out = formatCommitmentsBlock(
      [
        make(),
        make({
          id: "c2",
          kind: "deal_declined",
          exclusive: false,
          startDate: null,
          endDate: null,
          datePrecision: "none",
          counterpartyEmail: "wei@kolect.ai",
          counterpartyLabel: "Wei at Kolect",
          statement: "declined their $450 offer as below rate card",
        }),
      ],
      OPTS,
    );
    expect(out).toContain("already been agreed with this recipient");
    expect(out).toContain("declined their $450 offer");
  });

  test("a non-exclusive commitment never appears as a blocking window", () => {
    // A declined deal is useful context but must not reserve a date.
    const out = formatCommitmentsBlock([make({ kind: "deal_declined", exclusive: false })], {
      today: "2026-02-01",
    });
    expect(out).toBe("");
  });

  test("prior work is labelled as finished and explicitly not a constraint", () => {
    const out = formatCommitmentsBlock([], {
      today: "2026-08-14",
      recipientEmail: "melody@llano.com",
      history: [
        make({
          id: "h1",
          kind: "date_range",
          status: "fulfilled",
          exclusive: false,
          counterpartyEmail: "tutu@llano.com",
          counterpartyDomain: "llano.com",
          counterpartyLabel: "Tutu at llano",
          statement: "S9 Pro sponsored video, delivered",
          startDate: "2026-07-20",
          endDate: "2026-07-20",
        }),
      ],
    });
    expect(out).toContain("S9 Pro sponsored video, delivered");
    expect(out).toContain("do NOT block");
    // Must not be mistaken for a reserved window.
    expect(out).not.toContain("Do NOT offer or agree to any date");
  });

  test("history reaches a different contact at the same company", () => {
    // The case the feature exists for: a second person at a company the user
    // has already worked with, where an address-only match finds nothing.
    const history = [
      make({
        id: "h1",
        status: "fulfilled",
        exclusive: false,
        counterpartyEmail: "tutu@llano.com",
        counterpartyDomain: "llano.com",
        statement: "two sponsored videos delivered",
      }),
    ];
    expect(
      formatCommitmentsBlock([], {
        today: "2026-08-14",
        recipientEmail: "melody@llano.com",
        history,
      }),
    ).toContain("two sponsored videos delivered");
  });

  test("recipient facts also match on company, not just address", () => {
    const out = formatCommitmentsBlock(
      [
        make({
          kind: "terms",
          exclusive: false,
          startDate: null,
          endDate: null,
          counterpartyEmail: "tutu@llano.com",
          counterpartyDomain: "llano.com",
          statement: "agreed a 60-90 second integration format",
        }),
      ],
      { today: "2026-08-14", recipientEmail: "melody@llano.com" },
    );
    expect(out).toContain("60-90 second integration");
  });

  test("an unrelated company's history is not pulled in", () => {
    const out = formatCommitmentsBlock([], {
      today: "2026-08-14",
      recipientEmail: "wei@kolect.ai",
      history: [],
    });
    expect(out).toBe("");
  });

  test("caps the list so a busy quarter cannot crowd out the prompt", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      make({ id: `c${i}`, statement: `commitment ${i}` }),
    );
    const out = formatCommitmentsBlock(many, OPTS);
    expect(out.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(40);
  });
});
