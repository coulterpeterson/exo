/**
 * Extracts durable commitments from mail the user has SENT.
 *
 * Sent-only is deliberate: your own words are the authoritative record of what
 * you agreed to, and sent volume is a fraction of inbox volume so the cost
 * stays small. Quoted history is stripped first, which both sharpens the signal
 * (the counterparty's asks are not your commitments) and is the strongest
 * defence available against a hostile instruction pasted into a reply chain —
 * it never reaches the model at all.
 *
 * Unlike the draft/analysis learners there is no vote-and-promote tier: a deal
 * is stated once and would never earn a second vote. Confidence carries the
 * uncertainty instead, and anything below the bar is stored but marked
 * unconfirmed in both the UI and the prompt.
 */
import { randomUUID } from "crypto";
import { createMessage } from "./llm-service";
import { getConfig, getFeatureModelConfig } from "../ipc/settings.ipc";
import {
  getActiveCommitments,
  saveCommitment,
  supersedeCommitment,
  updateCommitment,
  hasExtractedCommitments,
  logCommitmentExtraction,
} from "../db";
import { stripQuotedContent } from "./strip-quoted-content";
import { shouldExtractCommitments } from "../utils/commitment-prefilter";
import { reconcileCommitment } from "../utils/commitment-reconcile";
import { todayISO, isIsoDate } from "../utils/date-range";
import { stripJsonFences } from "../../shared/strip-json-fences";
import { UNTRUSTED_DATA_INSTRUCTION, wrapUntrustedEmail } from "../../shared/prompt-safety";
import {
  CommitmentKindSchema,
  DatePrecisionSchema,
  type Commitment,
  type CommitmentKind,
  type DatePrecisionValue,
} from "../../shared/types";
import { createLogger } from "./logger";

const log = createLogger("commitment-extractor");

const useFakeData = process.env.EXO_TEST_MODE === "true" || process.env.EXO_DEMO_MODE === "true";

export interface ExtractCommitmentsParams {
  emailId: string;
  accountId: string;
  body: string;
  subject: string;
  toAddresses: string[];
  recipientLabel?: string;
  sentAt: number;
  threadId?: string;
  userEmail?: string;
}

export interface ExtractCommitmentsResult {
  saved: Commitment[];
  superseded: number;
  cancelled: number;
  skippedReason?: string;
}

interface RawCommitment {
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

function hasAnthropicCredentials(): boolean {
  const config = getConfig();
  return Boolean(config.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
}

function buildPrompt(params: ExtractCommitmentsParams, today: string): string {
  return `You extract durable commitments from an email the user has just SENT.

${UNTRUSTED_DATA_INSTRUCTION}

Today is ${today}. The email was sent on ${new Date(params.sentAt).toISOString().slice(0, 10)}.
It was sent to: ${params.toAddresses.join(", ") || "unknown"}.
Subject: ${params.subject}

Extract ONLY commitments the USER made or explicitly accepted/declined. Specifically:
- A date window the user promised (a video running Mar 3-14, a slot booked).
- A deal the user accepted or declined.
- Terms the user agreed to (a rate, exclusivity, usage rights).

Do NOT extract:
- Things the counterparty asked for that the user did not agree to.
- Hypotheticals or options ("if that works we could…", "I might be able to…").
  Require committal language: "confirmed", "we're booked", "yes let's do", "I'll run it", "I'm passing on this".
- Anything you are inferring rather than reading.

For each commitment return an object with:
  kind: "date_range" | "deal_accepted" | "deal_declined" | "terms" | "other"
  statement: one sentence, third-person, e.g. "Sponsored main-channel video running Mar 3-14"
  subject_matter: short label, e.g. "main channel sponsored video" (or null)
  start_date / end_date: "YYYY-MM-DD" or null. Resolve relative dates against the sent date.
  date_precision: "exact" | "week" | "month" | "quarter" | "open_ended" | "none"
    Use "month" for "sometime in March", "week" for "week of the 3rd", "exact" for explicit dates.
  amount_text: the money as written, verbatim, or null. Never convert or infer a number.
  status: "active", or "cancelled" if the email is cancelling a previously agreed commitment.
  confidence: 0..1. 0.9 = explicit and unambiguous. 0.6 = committal but hedged. 0.3 = implied.
  quote: a VERBATIM substring of the email text below that this is based on. Copy it exactly.

Respond with ONLY JSON: {"commitments": [...]}. An empty array is a correct and common answer.`;
}

function coerceKind(value: unknown): CommitmentKind {
  const parsed = CommitmentKindSchema.safeParse(value);
  return parsed.success ? parsed.data : "other";
}

function coercePrecision(value: unknown, hasDates: boolean): DatePrecisionValue {
  const parsed = DatePrecisionSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return hasDates ? "exact" : "none";
}

/**
 * Turn raw model output into commitments, dropping anything untrustworthy.
 *
 * The quote check is the cheapest deterministic hallucination guard available:
 * if the model can't point at the words it read this from, we don't keep it.
 */
export function parseExtractedCommitments(
  raw: unknown,
  sourceText: string,
  params: ExtractCommitmentsParams,
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

    const quote = typeof entry.quote === "string" ? entry.quote.trim() : "";
    if (!quote || !haystack.includes(quote.replace(/\s+/g, " ").toLowerCase())) {
      log.warn(
        `[Commitments] Dropped an extraction whose quote is not in the email (${statement.slice(0, 60)})`,
      );
      continue;
    }

    const startDate = isIsoDate(entry.start_date as string) ? (entry.start_date as string) : null;
    const endDate = isIsoDate(entry.end_date as string) ? (entry.end_date as string) : null;
    if (startDate && endDate && endDate < startDate) continue;

    const kind = coerceKind(entry.kind);
    const rawConfidence = typeof entry.confidence === "number" ? entry.confidence : 0.5;
    const confidence = Math.min(1, Math.max(0, rawConfidence));

    out.push({
      id: randomUUID(),
      accountId: params.accountId,
      kind,
      status: entry.status === "cancelled" ? "cancelled" : "active",
      counterpartyEmail: params.toAddresses[0]?.toLowerCase(),
      counterpartyDomain: params.toAddresses[0]?.split("@")[1]?.toLowerCase(),
      counterpartyLabel: params.recipientLabel ?? params.toAddresses[0],
      subjectMatter: typeof entry.subject_matter === "string" ? entry.subject_matter : undefined,
      statement,
      startDate,
      endDate,
      datePrecision: coercePrecision(entry.date_precision, !!(startDate || endDate)),
      // Only a real date window reserves time. A declined deal is durable
      // context but must never block a date.
      exclusive: kind === "date_range" && !!(startDate || endDate),
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

/**
 * The model call plus the post-parse guards, with no database involvement.
 *
 * Separated so the feature eval can grade exactly what would be persisted
 * without needing an initialised DB or writing rows during a test run.
 */
async function callExtractor(
  ownWords: string,
  params: ExtractCommitmentsParams,
  today: string,
): Promise<Commitment[]> {
  const { model, provider } = getFeatureModelConfig("analysis");
  const response = await createMessage(
    {
      model,
      max_tokens: 1024,
      system: buildPrompt(params, today),
      messages: [{ role: "user", content: wrapUntrustedEmail(ownWords.slice(0, 8000)) }],
    },
    {
      caller: "commitment-extractor",
      emailId: params.emailId,
      accountId: params.accountId,
      provider,
    },
  );
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("no text response");
  return parseExtractedCommitments(JSON.parse(stripJsonFences(block.text)), ownWords, params);
}

/** Eval-only entry point: strip, prefilter, extract — no persistence. */
export async function extractCommitmentsFromSentEmailForEval(
  params: ExtractCommitmentsParams,
): Promise<Commitment[]> {
  const own = stripQuotedContent(params.body).trim();
  const gate = shouldExtractCommitments(own, {
    toAddresses: params.toAddresses,
    userEmail: params.userEmail,
  });
  if (!gate.worthExtracting) return [];
  return callExtractor(own, params, todayISO());
}

export async function extractCommitmentsFromSentEmail(
  params: ExtractCommitmentsParams,
): Promise<ExtractCommitmentsResult> {
  if (useFakeData) return { saved: [], superseded: 0, cancelled: 0, skippedReason: "fake data" };
  if (!hasAnthropicCredentials()) {
    return { saved: [], superseded: 0, cancelled: 0, skippedReason: "no credentials" };
  }
  if (hasExtractedCommitments(params.emailId)) {
    return { saved: [], superseded: 0, cancelled: 0, skippedReason: "already processed" };
  }

  // Only the user's own words — quoted history is both noise and the main
  // injection surface.
  const own = stripQuotedContent(params.body).trim();
  const gate = shouldExtractCommitments(own, {
    toAddresses: params.toAddresses,
    userEmail: params.userEmail,
  });
  if (!gate.worthExtracting) {
    logCommitmentExtraction(params.emailId, params.accountId, 0, gate.reason);
    return { saved: [], superseded: 0, cancelled: 0, skippedReason: gate.reason };
  }

  const today = todayISO();
  let candidates: Commitment[] = [];
  try {
    candidates = await callExtractor(own, params, today);
  } catch (error) {
    // Never fail a send because extraction hiccupped. Not logged as processed,
    // so a later sync can retry this email.
    log.error({ err: error, emailId: params.emailId }, "[Commitments] Extraction failed");
    return { saved: [], superseded: 0, cancelled: 0, skippedReason: "extraction error" };
  }

  const existing = getActiveCommitments(params.accountId, today);
  const saved: Commitment[] = [];
  let superseded = 0;
  let cancelled = 0;

  for (const candidate of candidates) {
    const action = reconcileCommitment(candidate, [...existing, ...saved]);
    switch (action.type) {
      case "insert":
        saveCommitment(candidate);
        saved.push(candidate);
        break;
      case "supersede":
        saveCommitment(candidate);
        supersedeCommitment(action.existingId, candidate.id);
        saved.push(candidate);
        superseded++;
        break;
      case "cancel":
        updateCommitment(action.existingId, { status: "cancelled" });
        cancelled++;
        break;
      case "skip":
        log.info(`[Commitments] Skipped an extraction: ${action.reason}`);
        break;
    }
  }

  logCommitmentExtraction(params.emailId, params.accountId, saved.length);
  if (saved.length > 0 || cancelled > 0) {
    log.info(
      `[Commitments] ${saved.length} saved, ${superseded} superseded, ${cancelled} cancelled from ${params.emailId}`,
    );
  }
  return { saved, superseded, cancelled };
}
