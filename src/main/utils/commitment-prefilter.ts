/**
 * Decides whether a sent email is worth an extraction call.
 *
 * Most sent mail contains no commitment. Without a gate this feature would add
 * an LLM call to every send, so the bar is: the message must look like it is
 * doing business (a deal noun) AND either name a date or use committal
 * language. Precision matters more than recall here — a missed commitment is an
 * inconvenience the user can fix by hand, whereas the cost of scanning
 * everything is paid forever.
 */
import { looksDateish } from "./date-text";

/** Below this (after quoted text is stripped) there is nothing to extract. */
export const MIN_BODY_CHARS = 120;

const DEAL_NOUNS =
  /\b(sponsor(?:ship|ed)?|brand|campaign|integration|placement|insertion|segment|video|short|rate card|rate|invoice|contract|deal|budget|cpm|deliverabl\w*|brief|collab(?:oration)?|partnership|usage rights|exclusivity)\b/i;

const COMMITTAL =
  /\b(confirm(?:ed|ing)?|lock(?:ed|ing)? (?:it )?in|booked|accept(?:ed|ing)?|agree(?:d)?|deal|sign(?:ed)?|decline(?:d)?|pass(?:ing)? on|we'?re on|going ahead|approved|committed)\b/i;

const AUTO_REPLY =
  /\b(out of (?:the )?office|automatic reply|auto-?reply|vacation responder|do not reply|unsubscribe)\b/i;

export interface PrefilterResult {
  worthExtracting: boolean;
  reason: string;
}

/**
 * @param body sent-message text with quoted history already stripped, so only
 *   the user's own words are considered — better signal, and the strongest
 *   defence against a commitment "instruction" pasted in by a counterparty.
 */
export function shouldExtractCommitments(
  body: string,
  opts: { toAddresses?: string[]; userEmail?: string } = {},
): PrefilterResult {
  const text = body.trim();

  if (text.length < MIN_BODY_CHARS) {
    return { worthExtracting: false, reason: "body too short" };
  }
  if (AUTO_REPLY.test(text)) {
    return { worthExtracting: false, reason: "auto-reply" };
  }

  const recipients = (opts.toAddresses ?? []).map((a) => a.toLowerCase());
  const me = opts.userEmail?.toLowerCase();
  if (me && recipients.length > 0 && recipients.every((r) => r === me)) {
    return { worthExtracting: false, reason: "note to self" };
  }

  if (!DEAL_NOUNS.test(text)) {
    return { worthExtracting: false, reason: "no deal vocabulary" };
  }
  if (!looksDateish(text) && !COMMITTAL.test(text)) {
    return { worthExtracting: false, reason: "no dates and nothing committal" };
  }

  return { worthExtracting: true, reason: "deal vocabulary plus dates or commitment language" };
}
