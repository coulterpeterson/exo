/**
 * Works out which dates an incoming email is asking about.
 *
 * Needed because "I avoided Mar 3–14" can only be claimed if we know Mar 3–14
 * was on the table — an avoided window is by definition absent from the draft,
 * so scanning the output can never tell us.
 *
 * Two-stage on purpose. The regex scanner handles the common phrasings for
 * free; the LLM is only consulted when the text looks date-ish but the scanner
 * found nothing parseable ("the first two weeks of next month", "the window we
 * discussed"). Combined with the caller's gate — only when the account actually
 * has a blocking commitment — this costs nothing on the overwhelming majority
 * of mail.
 */
import { createMessage } from "./llm-service";
import { getFeatureModelConfig } from "../ipc/settings.ipc";
import { findDateRangesInText, looksDateish } from "../utils/date-text";
import { isIsoDate, type DateRange } from "../utils/date-range";
import { stripJsonFences } from "../../shared/strip-json-fences";
import { UNTRUSTED_DATA_INSTRUCTION, wrapUntrustedEmail } from "../../shared/prompt-safety";
import { createLogger } from "./logger";

const log = createLogger("requested-window");

/** Merge every mentioned range into the widest span. A sponsor proposing
 *  "Mar 3-14 or Mar 20-28" is asking about a period that spans both, and
 *  blocking either one is worth surfacing. */
export function mergeRanges(ranges: DateRange[]): DateRange | null {
  const dated = ranges.filter((r) => r.start || r.end);
  if (dated.length === 0) return null;
  let start: string | null = null;
  let end: string | null = null;
  for (const r of dated) {
    if (r.start && (start === null || r.start < start)) start = r.start;
    if (r.end && (end === null || r.end > end)) end = r.end;
  }
  return { start, end: end ?? start };
}

export async function extractRequestedWindow(
  body: string,
  emailDateIso: string,
  opts: { emailId?: string; accountId?: string } = {},
): Promise<DateRange | null> {
  const text = body.slice(0, 8000);
  if (!looksDateish(text)) return null;

  const scanned = mergeRanges(findDateRangesInText(text, emailDateIso));
  if (scanned) return scanned;

  // Date-ish but unparseable — worth one small call.
  try {
    const { model, provider } = getFeatureModelConfig("calendaring");
    const response = await createMessage(
      {
        model,
        max_tokens: 200,
        system: `You identify the date range an email is asking about.

${UNTRUSTED_DATA_INSTRUCTION}

Today's reference date is ${emailDateIso}. Respond with ONLY JSON:
{"start": "YYYY-MM-DD" | null, "end": "YYYY-MM-DD" | null}

Rules:
- Only report dates the sender is proposing or asking about for scheduling.
- Resolve relative phrases ("next month", "the first two weeks of April") against the reference date.
- If no schedulable dates are being discussed, return {"start": null, "end": null}.`,
        messages: [{ role: "user", content: wrapUntrustedEmail(text) }],
      },
      { caller: "requested-window", emailId: opts.emailId, accountId: opts.accountId, provider },
    );

    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return null;
    const parsed = JSON.parse(stripJsonFences(block.text)) as {
      start?: unknown;
      end?: unknown;
    };
    const start = isIsoDate(parsed.start as string) ? (parsed.start as string) : null;
    const end = isIsoDate(parsed.end as string) ? (parsed.end as string) : null;
    if (!start && !end) return null;
    // A start with no end is a single day, not an open-ended claim on the future.
    return { start, end: end ?? start };
  } catch (error) {
    // Never block drafting on this — worst case we skip the conflict check.
    log.warn({ err: error }, "[RequestedWindow] Could not determine requested dates");
    return null;
  }
}
