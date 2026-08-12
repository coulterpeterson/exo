/**
 * Decides what to do with a freshly extracted commitment given what's already
 * stored: insert it, retire an older one, cancel one, or do nothing.
 *
 * Deterministic on purpose — no second LLM call. Counterparty identity plus
 * date overlap is enough to recognise "same deal, new terms", and a rule you
 * can read is worth more than a model's judgement when the outcome is silently
 * rewriting a record of what you agreed to.
 */
import { rangesOverlap } from "./date-range";
import type { Commitment } from "../../shared/types";

export type ReconcileAction =
  | { type: "insert"; candidate: Commitment }
  | { type: "supersede"; existingId: string; candidate: Commitment }
  | { type: "cancel"; existingId: string }
  | { type: "skip"; reason: string };

function sameCounterparty(a: Commitment, b: Commitment): boolean {
  if (a.counterpartyEmail && b.counterpartyEmail) {
    return a.counterpartyEmail.toLowerCase() === b.counterpartyEmail.toLowerCase();
  }
  // Domain alone is "related, probably not identical" — two people at the same
  // agency can hold genuinely separate deals, so it must not trigger a
  // supersede. Fall back to the human label only when both lack an address.
  if (a.counterpartyLabel && b.counterpartyLabel) {
    return a.counterpartyLabel.trim().toLowerCase() === b.counterpartyLabel.trim().toLowerCase();
  }
  return false;
}

function sameSubject(a: Commitment, b: Commitment): boolean {
  const sa = a.subjectMatter?.trim().toLowerCase();
  const sb = b.subjectMatter?.trim().toLowerCase();
  if (!sa || !sb) return true; // unknown subject — don't let it block a match
  return sa === sb;
}

function overlapsOrAdjacent(a: Commitment, b: Commitment): boolean {
  if (!a.startDate && !a.endDate) return true;
  if (!b.startDate && !b.endDate) return true;
  return rangesOverlap(
    { start: a.startDate ?? null, end: a.endDate ?? null },
    { start: b.startDate ?? null, end: b.endDate ?? null },
  );
}

function identical(a: Commitment, b: Commitment): boolean {
  return (
    a.kind === b.kind &&
    (a.startDate ?? null) === (b.startDate ?? null) &&
    (a.endDate ?? null) === (b.endDate ?? null) &&
    a.statement.trim().toLowerCase() === b.statement.trim().toLowerCase()
  );
}

/**
 * @param existingActive active commitments for the same account.
 */
export function reconcileCommitment(
  candidate: Commitment,
  existingActive: Commitment[],
): ReconcileAction {
  const related = existingActive.filter(
    (e) => sameCounterparty(e, candidate) && sameSubject(e, candidate),
  );

  // Cancellation is checked first: "we're cancelling the Mar 3-14 slot" often
  // restates the deal verbatim, so the duplicate check below would otherwise
  // swallow it and leave the window looking live.
  if (candidate.status === "cancelled") {
    const target = related.find((e) => overlapsOrAdjacent(e, candidate));
    return target
      ? { type: "cancel", existingId: target.id }
      : { type: "skip", reason: "cancellation with nothing to cancel" };
  }

  const duplicate = related.find((e) => identical(e, candidate));
  if (duplicate) {
    return { type: "skip", reason: `duplicate of ${duplicate.id}` };
  }

  const match = related.find((e) => e.kind === candidate.kind && overlapsOrAdjacent(e, candidate));
  if (!match) return { type: "insert", candidate };

  // Never let an unreviewed extraction overwrite something the user confirmed.
  // Silently rewriting a human correction is the worst failure this system can
  // have, so both rows stay and the UI surfaces them as an overlap to resolve.
  if (match.confirmed && !candidate.confirmed) {
    return { type: "insert", candidate };
  }

  // Order by when the mail was SENT, not when we processed it. Backfill and
  // out-of-order sync would otherwise let an older email overwrite a newer one.
  const matchAt = match.sourceSentAt ?? match.createdAt;
  const candidateAt = candidate.sourceSentAt ?? candidate.createdAt;
  if (candidateAt < matchAt) {
    return { type: "skip", reason: `older than existing ${match.id}` };
  }

  return { type: "supersede", existingId: match.id, candidate };
}
