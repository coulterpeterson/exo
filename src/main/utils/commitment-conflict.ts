/**
 * Turns "these dates were requested" + "these windows are already promised"
 * into a decision, a prompt mandate, and the record the UI renders.
 *
 * All of it happens in code rather than in the model. That is what makes the
 * summary claim checkable: we know which window we steered away from and which
 * one we offered instead, because we chose them.
 *
 * Dependency-free so it can be unit tested — every consumer imports Electron.
 */
import { isUnconfirmedCommitment, type Commitment, type ConflictAvoided } from "../../shared/types";
import {
  addDays,
  daysBetween,
  findFreeWindow,
  formatRange,
  isHardConflict,
  rangesOverlap,
  type BlockedWindow,
  type DateRange,
} from "./date-range";

/** How far ahead findFreeWindow will look for an alternative. */
export const ALTERNATIVE_HORIZON_DAYS = 180;

function label(c: Commitment): string {
  return c.counterpartyLabel ?? c.counterpartyEmail ?? "another party";
}

/** Only dated, exclusive, active commitments can block anything. */
export function toBlockedWindows(commitments: Commitment[]): BlockedWindow[] {
  return commitments
    .filter((c) => c.exclusive && (c.startDate || c.endDate))
    .map((c) => ({
      id: c.id,
      label: label(c),
      range: { start: c.startDate ?? null, end: c.endDate ?? null },
      precision: c.datePrecision,
    }));
}

export interface ConflictPlan {
  conflicts: ConflictAvoided[];
  /** Appended to the draft prompt. Empty when there is nothing to steer around. */
  mandate: string;
}

/**
 * Decide what to do about a requested window.
 *
 * Every conflict starts life as "avoided" — provisional, because we are about
 * to instruct the model away from it. verifyConflictsAgainstBody downgrades any
 * the finished draft ignored.
 */
export function planConflicts(
  requested: DateRange | null,
  commitments: Commitment[],
): ConflictPlan {
  if (!requested || (!requested.start && !requested.end)) {
    return { conflicts: [], mandate: "" };
  }

  const blocked = toBlockedWindows(commitments);
  const byId = new Map(commitments.map((c) => [c.id, c]));
  const hits = blocked.filter((b) => rangesOverlap(requested, b.range));
  if (hits.length === 0) return { conflicts: [], mandate: "" };

  // Only hard-precision windows justify moving the date. A "sometime in March"
  // commitment is worth mentioning but must not push a concrete proposal.
  const hard = hits.filter((b) => isHardConflict(b.precision));
  const lengthDays =
    requested.start && requested.end ? daysBetween(requested.start, requested.end) : 1;
  const earliest = requested.start ?? blocked[0]?.range.start ?? null;

  const alternative =
    hard.length > 0 && earliest
      ? findFreeWindow(blocked, {
          lengthDays,
          earliest,
          latest: addDays(earliest, ALTERNATIVE_HORIZON_DAYS),
        })
      : null;

  const conflicts: ConflictAvoided[] = hits.map((b) => {
    const c = byId.get(b.id)!;
    const hard = isHardConflict(b.precision);
    return {
      commitmentId: b.id,
      counterpartyLabel: b.label ?? "another party",
      blockedRange: b.range,
      precision: b.precision,
      requestedRange: requested,
      proposedRange: hard ? alternative : null,
      // Provisional: a soft conflict is never "avoided" because we never moved
      // the date for it, only mentioned it.
      outcome: hard ? "avoided" : "flagged",
      unconfirmed: isUnconfirmedCommitment(c),
      reason: hard
        ? `${formatRange(requested)} overlaps ${formatRange(b.range)} already committed to ${b.label}`
        : `${formatRange(requested)} may overlap an approximate commitment to ${b.label} (${formatRange(b.range)})`,
    };
  });

  const lines: string[] = [];
  for (const b of hard) {
    const c = byId.get(b.id)!;
    const caveat = isUnconfirmedCommitment(c)
      ? " (this one is unconfirmed — mention it as tentative)"
      : "";
    lines.push(`- ${formatRange(b.range)} is already committed to ${b.label}${caveat}.`);
  }
  for (const b of hits.filter((h) => !isHardConflict(h.precision))) {
    lines.push(`- ${formatRange(b.range)} may be committed to ${b.label} (approximate dates).`);
  }

  let mandate = `SCHEDULING CONSTRAINT — the dates this email asks about are not fully available.\n${lines.join("\n")}`;
  if (alternative) {
    mandate += `\n\nDo NOT offer or agree to ${formatRange(requested)}. Offer ${formatRange(alternative)} instead, and say plainly that the requested dates aren't available. Do not name the other party or disclose who the conflict is with.`;
  } else if (hard.length > 0) {
    mandate += `\n\nDo NOT offer or agree to ${formatRange(requested)}. Say the requested dates aren't available and ask what other timing would work. Do not name the other party.`;
  } else {
    mandate += `\n\nDo not hard-commit to these dates; flag that timing may already be spoken for and confirm before locking it in.`;
  }

  return { conflicts, mandate };
}

/**
 * Downgrade any conflict the finished draft ignored.
 *
 * Without this the UI could assert an avoidance that never happened. Callers
 * pass a predicate rather than the text so this stays dependency-free.
 */
export function verifyConflictsAgainstBody(
  conflicts: ConflictAvoided[],
  bodyMentionsRange: (range: DateRange) => boolean,
): ConflictAvoided[] {
  return conflicts.map((c) => {
    if (c.outcome !== "avoided") return c;
    if (!bodyMentionsRange(c.blockedRange)) return c;
    return {
      ...c,
      outcome: "flagged" as const,
      proposedRange: null,
      reason: `${c.reason} — the draft still refers to these dates, so this was not avoided`,
    };
  });
}
