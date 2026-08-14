/**
 * What survives the trip from model output to the commitments table.
 *
 * Two rules here are load-bearing beyond their size. `exclusive` decides
 * whether a row refuses dates in future drafts, so a completed video that
 * kept it would silently block a month that is actually free. And status is
 * clamped to the three values the model is allowed to emit, because
 * "superseded" is reconciliation's to assign — accepting it from a model would
 * retire a real commitment with none of reconcileCommitment's checks.
 */
import { test, expect } from "@playwright/test";
import {
  parseExtractedCommitments,
  coerceStatus,
  type ParseCommitmentsParams,
} from "../../src/main/utils/commitment-parse";

const PARAMS: ParseCommitmentsParams = {
  emailId: "e1",
  accountId: "default",
  toAddresses: ["Tutu@Llano.com"],
  sentAt: 1000,
};

const BODY =
  "Great - I can confirm the second payment came through successfully. The S9 Pro video went " +
  "live on July 20 and final payment came through on August 5. For the next one I think the " +
  "60-90 second integration would be the better fit. We'll run it March 3-14.";

function parseOne(entry: Record<string, unknown>, body = BODY) {
  const out = parseExtractedCommitments({ commitments: [entry] }, body, PARAMS);
  return out[0];
}

test.describe("parseExtractedCommitments", () => {
  test("keeps a dated window and marks it exclusive", () => {
    const c = parseOne({
      kind: "date_range",
      statement: "sponsored video running Mar 3-14",
      start_date: "2027-03-03",
      end_date: "2027-03-14",
      date_precision: "exact",
      status: "active",
      confidence: 0.9,
      quote: "We'll run it March 3-14",
    });
    expect(c.exclusive).toBe(true);
    expect(c.status).toBe("active");
  });

  test("a fulfilled deal is recorded but never blocks a date", () => {
    const c = parseOne({
      kind: "date_range",
      statement: "S9 Pro video delivered",
      start_date: "2026-07-20",
      end_date: "2026-07-20",
      date_precision: "exact",
      status: "fulfilled",
      confidence: 0.95,
      quote: "The S9 Pro video went live on July 20",
    });
    expect(c.status).toBe("fulfilled");
    // The whole point of recording history: present, but not a constraint.
    expect(c.exclusive).toBe(false);
  });

  test("a cancelled window stops reserving time", () => {
    const c = parseOne({
      kind: "date_range",
      statement: "March slot",
      start_date: "2027-03-03",
      end_date: "2027-03-14",
      status: "cancelled",
      quote: "We'll run it March 3-14",
    });
    expect(c.exclusive).toBe(false);
  });

  test("an undated scope commitment is kept", () => {
    const c = parseOne({
      kind: "terms",
      statement: "60-90 second integration agreed as the format",
      start_date: null,
      end_date: null,
      date_precision: "none",
      status: "active",
      confidence: 0.8,
      quote: "the 60-90 second integration would be the better fit",
    });
    expect(c.kind).toBe("terms");
    expect(c.startDate).toBeNull();
    expect(c.datePrecision).toBe("none");
    // No window means nothing to reserve, whatever the kind says.
    expect(c.exclusive).toBe(false);
  });

  test("refuses a model-supplied 'superseded' — that is reconciliation's call", () => {
    expect(coerceStatus("superseded")).toBe("active");
    expect(coerceStatus("nonsense")).toBe("active");
    expect(coerceStatus(undefined)).toBe("active");
    expect(coerceStatus("fulfilled")).toBe("fulfilled");
    expect(coerceStatus("cancelled")).toBe("cancelled");
  });

  test("drops an entry whose quote is not in the email", () => {
    const dropped: string[] = [];
    const out = parseExtractedCommitments(
      {
        commitments: [
          {
            kind: "date_range",
            statement: "invented exclusivity through December",
            quote: "I agree to full category exclusivity through December",
            status: "active",
          },
        ],
      },
      BODY,
      PARAMS,
      (reason) => dropped.push(reason),
    );
    expect(out).toHaveLength(0);
    expect(dropped).toEqual(["quote is not in the email"]);
  });

  test("matches quotes across reflowed whitespace", () => {
    const c = parseOne(
      {
        kind: "terms",
        statement: "60-90 second integration",
        quote: "the 60-90 second   integration\n would be the better fit",
        status: "active",
      },
      BODY,
    );
    expect(c).toBeTruthy();
  });

  test("drops a backwards range rather than storing a window that can't exist", () => {
    const dropped: string[] = [];
    parseExtractedCommitments(
      {
        commitments: [
          {
            kind: "date_range",
            statement: "backwards",
            start_date: "2027-03-14",
            end_date: "2027-03-03",
            quote: "We'll run it March 3-14",
          },
        ],
      },
      BODY,
      PARAMS,
      (reason) => dropped.push(reason),
    );
    expect(dropped).toEqual(["end date precedes start date"]);
  });

  test("clamps confidence and lowercases the counterparty", () => {
    const c = parseOne({
      kind: "other",
      statement: "something",
      confidence: 4.2,
      quote: "final payment came through on August 5",
    });
    expect(c.confidence).toBe(1);
    expect(c.counterpartyEmail).toBe("tutu@llano.com");
    expect(c.counterpartyDomain).toBe("llano.com");
  });

  test("an empty array is a correct answer, not a failure", () => {
    expect(parseExtractedCommitments({ commitments: [] }, BODY, PARAMS)).toEqual([]);
    expect(parseExtractedCommitments({}, BODY, PARAMS)).toEqual([]);
    expect(parseExtractedCommitments(null, BODY, PARAMS)).toEqual([]);
  });
});
