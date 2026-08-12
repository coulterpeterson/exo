/**
 * Feature-eval runner for the commitment extractor.
 *
 * Exercises the real prompt and the real post-parse guards (verbatim-quote
 * validation, kind/precision coercion, backwards-range rejection) so a fixture
 * grades what actually reaches the database, not just what the model said.
 *
 * Grade these on PRECISION. A missed commitment is an inconvenience the user
 * fixes by hand; a fabricated one silently steers a live negotiation.
 */
import { extractCommitmentsFromSentEmailForEval } from "../../../src/main/services/commitment-extractor";

interface CommitmentFixtureInput {
  /** The sent email body, as the user wrote it. */
  body: string;
  subject?: string;
  toAddresses?: string[];
  /** ISO date the message was sent — anchors relative dates. */
  sentDate?: string;
}

function isInput(value: unknown): value is CommitmentFixtureInput {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { body?: unknown }).body === "string"
  );
}

export async function runCommitmentExtractorFixture(
  input: unknown,
  fixtureId: string,
): Promise<string> {
  if (!isInput(input)) {
    throw new Error(
      `[commitment-extractor] fixture ${fixtureId}: input must include a body string`,
    );
  }
  const sentAt = input.sentDate ? Date.parse(`${input.sentDate}T12:00:00Z`) : Date.now();
  const result = await extractCommitmentsFromSentEmailForEval({
    emailId: `eval-${fixtureId}`,
    accountId: "eval",
    body: input.body,
    subject: input.subject ?? "",
    toAddresses: input.toAddresses ?? ["sponsor@example.com"],
    sentAt,
  });

  // Report only the fields a rubric should judge — ids and timestamps are noise.
  return JSON.stringify(
    result.map((c) => ({
      kind: c.kind,
      status: c.status,
      statement: c.statement,
      start_date: c.startDate,
      end_date: c.endDate,
      date_precision: c.datePrecision,
      exclusive: c.exclusive,
      confidence: c.confidence,
      quote: c.sourceQuote,
    })),
    null,
    2,
  );
}
