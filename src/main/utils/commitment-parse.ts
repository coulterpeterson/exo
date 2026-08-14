/**
 * Turns raw extractor output into commitments, dropping anything untrustworthy.
 *
 * Lives in utils/ rather than beside the extractor because the extractor
 * imports the database and therefore Electron, which makes it unreachable from
 * the unit suite. These rules decide what gets written into a store that then
 * steers live negotiation drafts, so they are exactly the part that needs
 * tests: a wrong `exclusive` refuses dates that are actually free, and a
 * `superseded` accepted from the model would retire a real commitment without
 * any of the checks reconcileCommitment performs.
 */
import { randomUUID } from "crypto";
import { isIsoDate } from "./date-range";
import {
  CommitmentKindSchema,
  DatePrecisionSchema,
  type Commitment,
  type CommitmentKind,
  type CommitmentStatus,
  type DatePrecisionValue,
} from "../../shared/types";

/** One entry as the model emitted it — every field still unknown. */
export interface RawCommitment {
  kind?: unknown;
  statement?: unknown;
  subject_matter?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  date_precision?: unknown;
  amount_text?: unknown;
  status?: unknown;
  confidence?: unknown;
  quote?: unknown;
}

/** The subset of extraction params the parse actually needs. */
export interface ParseCommitmentsParams {
  emailId: string;
  accountId: string;
  toAddresses: string[];
  recipientLabel?: string;
  sentAt: number;
  threadId?: string;
}

function coerceKind(value: unknown): CommitmentKind {
  const parsed = CommitmentKindSchema.safeParse(value);
  return parsed.success ? parsed.data : "other";
}

/**
 * "superseded" is assigned by reconciliation from the ordering of sent dates,
 * never by the model — accepting it here would let one extraction silently
 * retire another. Anything unrecognised falls back to "active".
 */
export function coerceStatus(value: unknown): CommitmentStatus {
  return value === "cancelled" || value === "fulfilled" ? value : "active";
}

function coercePrecision(value: unknown, hasDates: boolean): DatePrecisionValue {
  const parsed = DatePrecisionSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return hasDates ? "exact" : "none";
}

/**
 * @param onDropped called for each discarded entry. The caller owns logging —
 *   this module stays dependency-free so the unit suite can reach it.
 */
export function parseExtractedCommitments(
  raw: unknown,
  sourceText: string,
  params: ParseCommitmentsParams,
  onDropped?: (reason: string, statement: string) => void,
): Commitment[] {
  const list = (raw as { commitments?: unknown })?.commitments;
  if (!Array.isArray(list)) return [];

  const haystack = sourceText.replace(/\s+/g, " ").toLowerCase();
  const now = Date.now();
  const out: Commitment[] = [];

  for (const entry of list as RawCommitment[]) {
    if (!entry || typeof entry !== "object") continue;
    const statement = typeof entry.statement === "string" ? entry.statement.trim() : "";
    if (!statement) continue;

    // The cheapest deterministic hallucination guard available: if the model
    // can't point at the words it read this from, we don't keep it.
    const quote = typeof entry.quote === "string" ? entry.quote.trim() : "";
    if (!quote || !haystack.includes(quote.replace(/\s+/g, " ").toLowerCase())) {
      onDropped?.("quote is not in the email", statement);
      continue;
    }

    const startDate = isIsoDate(entry.start_date as string) ? (entry.start_date as string) : null;
    const endDate = isIsoDate(entry.end_date as string) ? (entry.end_date as string) : null;
    if (startDate && endDate && endDate < startDate) {
      onDropped?.("end date precedes start date", statement);
      continue;
    }

    const kind = coerceKind(entry.kind);
    const status = coerceStatus(entry.status);
    const rawConfidence = typeof entry.confidence === "number" ? entry.confidence : 0.5;
    const confidence = Math.min(1, Math.max(0, rawConfidence));

    out.push({
      id: randomUUID(),
      accountId: params.accountId,
      kind,
      status,
      counterpartyEmail: params.toAddresses[0]?.toLowerCase(),
      counterpartyDomain: params.toAddresses[0]?.split("@")[1]?.toLowerCase(),
      counterpartyLabel: params.recipientLabel ?? params.toAddresses[0],
      subjectMatter: typeof entry.subject_matter === "string" ? entry.subject_matter : undefined,
      statement,
      startDate,
      endDate,
      datePrecision: coercePrecision(entry.date_precision, !!(startDate || endDate)),
      // Only a real, still-outstanding date window reserves time. A declined
      // deal is durable context but must never block a date, and neither can
      // work that is already delivered or a booking that was cancelled.
      exclusive: status === "active" && kind === "date_range" && !!(startDate || endDate),
      confidence,
      confirmed: false,
      source: "sent-extractor",
      sourceEmailId: params.emailId,
      sourceThreadId: params.threadId,
      sourceSentAt: params.sentAt,
      sourceQuote: quote,
      notes: typeof entry.amount_text === "string" ? entry.amount_text : undefined,
      createdAt: now,
      updatedAt: now,
    });
  }

  return out;
}
