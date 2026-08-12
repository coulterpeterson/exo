/**
 * Renders commitments into the prompt block that drafting sees.
 *
 * Dependency-free so it can be unit tested — the wording here decides whether
 * the model double-books a sponsor, so it is worth pinning down.
 */
import { isUnconfirmedCommitment, type Commitment } from "../../shared/types";
import { formatRange } from "./date-range";

/** Cap so a busy quarter can't crowd the rest of the prompt out. Ordered by
 *  start date, so the nearest (most likely to be discussed) survive. */
export const MAX_COMMITMENT_LINES = 40;

function line(c: Commitment): string {
  const who = c.counterpartyLabel ?? c.counterpartyEmail ?? "unknown counterparty";
  const when =
    c.startDate || c.endDate
      ? `[${formatRange({ start: c.startDate ?? null, end: c.endDate ?? null })}] `
      : "";
  const soft =
    c.datePrecision === "month" || c.datePrecision === "quarter" ? " (approximate dates)" : "";
  const shaky = isUnconfirmedCommitment(c) ? " (unconfirmed — verify before relying on it)" : "";
  return `- ${when}${who} — ${c.statement}${soft}${shaky}`;
}

/**
 * Two sections: windows already promised to anyone (the cross-sender
 * constraint), and standing facts about the person being replied to.
 *
 * Returns "" when there is nothing to say, so callers can concatenate blindly.
 */
export function formatCommitmentsBlock(
  commitments: Commitment[],
  opts: { today: string; recipientEmail?: string },
): string {
  if (commitments.length === 0) return "";

  const recipient = opts.recipientEmail?.toLowerCase();

  // Blocking windows from every counterparty — including the recipient, since
  // a window promised to them still constrains a second promise to them.
  const windows = commitments
    .filter((c) => c.exclusive && (c.startDate || c.endDate))
    .slice(0, MAX_COMMITMENT_LINES);

  // Non-date facts about this recipient: accepted/declined/terms.
  const aboutRecipient = recipient
    ? commitments
        .filter((c) => !(c.exclusive && (c.startDate || c.endDate)))
        .filter((c) => c.counterpartyEmail?.toLowerCase() === recipient)
        .slice(0, MAX_COMMITMENT_LINES)
    : [];

  if (windows.length === 0 && aboutRecipient.length === 0) return "";

  const sections: string[] = [];

  // State the date explicitly — the drafting model has no reliable notion of
  // "now", and every relative-date decision below depends on it.
  sections.push(`Today's date is ${opts.today}.`);

  if (windows.length > 0) {
    sections.push(
      `Dates already committed to other parties. Do NOT offer or agree to any date that falls inside these windows — propose the nearest clear window instead, and say plainly that the requested dates aren't available:\n${windows
        .map(line)
        .join("\n")}`,
    );
  }

  if (aboutRecipient.length > 0) {
    sections.push(
      `What has already been agreed with this recipient:\n${aboutRecipient.map(line).join("\n")}`,
    );
  }

  return `=== ACTIVE COMMITMENTS ===\n${sections.join("\n\n")}\n`;
}
