/**
 * Builds the commitments prompt block for draft generation.
 *
 * Sibling of memory-context.ts, but deliberately NOT sender-scoped. That is the
 * entire point of the feature: what you promised sponsor A is exactly what must
 * constrain the reply you send sponsor B, and every existing memory-injection
 * path keys on the recipient and so can never surface it.
 *
 * The formatting logic lives in utils/commitment-format.ts so it can be unit
 * tested — this module imports the DB and therefore Electron.
 */
import { getActiveCommitments } from "../db";
import { todayISO } from "../utils/date-range";
import { formatCommitmentsBlock } from "../utils/commitment-format";

/**
 * @param recipientEmail lowercased address being replied to, used only to
 *   split "facts about this person" out of the account-wide list.
 */
export function buildCommitmentContext(
  accountId: string,
  recipientEmail?: string,
  now: Date = new Date(),
): string {
  const today = todayISO(now);
  const commitments = getActiveCommitments(accountId, today);
  return formatCommitmentsBlock(commitments, { today, recipientEmail });
}
