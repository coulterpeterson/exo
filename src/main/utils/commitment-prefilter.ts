/**
 * Decides whether a sent email is worth an extraction call.
 *
 * Most sent mail contains no commitment. Without a gate this feature would add
 * an LLM call to every send, so the bar is: the message must look like it is
 * doing business (a deal noun) AND carry at least one of four signals — a date,
 * committal language, a settled scope, or work described as delivered.
 *
 * The last two exist because a date-or-committal gate silently dropped two real
 * categories: "the 60-90 second integration is the better fit" commits to a
 * deliverable with no date anywhere in it, and "the video went live July 20" is
 * the deal history you want when a different contact at that company writes in.
 * Both cost an extra call on some sends; a missed commitment costs a
 * double-booking.
 */
import { looksDateish } from "./date-text";

/** Below this (after quoted text is stripped) there is nothing to extract. */
export const MIN_BODY_CHARS = 120;

const DEAL_NOUNS =
  /\b(sponsor(?:ship|ed)?|brand|campaign|integration|placement|insertion|segment|video|short|rate card|rate|invoice|contract|deal|budget|cpm|deliverabl\w*|brief|collab(?:oration)?|partnership|usage rights|exclusivity)\b/i;

const COMMITTAL =
  /\b(confirm(?:ed|ing)?|lock(?:ed|ing)? (?:it )?in|booked|accept(?:ed|ing)?|agree(?:d)?|deal|sign(?:ed)?|decline(?:d)?|pass(?:ing)? on|we'?re on|going ahead|approved|committed)\b/i;

/**
 * A settled choice of scope or format. Commits the user to something real
 * without naming a date, so a date-or-committal-word gate misses it entirely
 * ("the 60-90 second integration is the better fit").
 */
const SCOPE_CHOICE =
  /\b(better fit|best fit|(?:go|going) with|let'?s do|i'?ll do|we'?ll do|makes more sense|i'?d rather|rather than|instead of)\b/i;

/**
 * Work stated as already done. Not a promise, but it is the deal history that
 * matters when a second contact at the same company writes in later.
 */
const DELIVERED =
  /\b(went live|going live|published|shipped|delivered|wrapped(?: up)?|invoiced|paid|payment (?:came|cleared|received|arrived))\b/i;

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
  if (
    !looksDateish(text) &&
    !COMMITTAL.test(text) &&
    !SCOPE_CHOICE.test(text) &&
    !DELIVERED.test(text)
  ) {
    return {
      worthExtracting: false,
      reason: "no dates, commitment, settled scope, or delivered work",
    };
  }

  return {
    worthExtracting: true,
    reason: "deal vocabulary plus dates, commitment, scope, or delivery",
  };
}
