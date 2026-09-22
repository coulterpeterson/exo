/**
 * Decides which newly arrived messages are worth announcing.
 *
 * Deliberately free of electron and the database: everything here is a
 * decision about a message, and the decisions are where the edge cases live
 * (the launch backlog, a resync re-delivering mail, an analysis verdict that
 * lands minutes after the message did). notification-service.ts owns the
 * timers, the badge and the actual Notification objects.
 */
import type { NotificationScope } from "../../shared/types";

export interface ArrivedEmail {
  id: string;
  threadId: string;
  accountId?: string;
  from: string;
  subject: string;
  labelIds?: string[];
  analysis?: { needsReply: boolean };
}

export interface Candidate {
  emailId: string;
  threadId: string;
  accountId: string;
  from: string;
  subject: string;
  queuedAt: number;
}

/** A candidate awaiting an analysis verdict is abandoned after this long. With
 *  analysis disabled or failing, "priority" would otherwise grow without bound
 *  and fire notifications for mail that arrived an hour ago. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

export class NotificationPolicy {
  /** Accounts past their first sync cycle. Before that, everything arriving
   *  is the backlog being pulled down at launch, not news. */
  private primed = new Set<string>();
  /** Waiting on an analysis verdict (priority scope only). */
  private pending = new Map<string, Candidate>();
  /** Already decided — a resync must not announce the same message twice. */
  private decided = new Set<string>();

  isPrimed(accountId: string): boolean {
    return this.primed.has(accountId);
  }

  /** Returns true the first time, so the caller can log the transition. */
  markPrimed(accountId: string): boolean {
    if (this.primed.has(accountId)) return false;
    this.primed.add(accountId);
    return true;
  }

  forgetAccount(accountId: string): void {
    this.primed.delete(accountId);
  }

  /**
   * Sort an arrival batch. Anything returned should be announced now;
   * anything held is waiting for its analysis verdict.
   */
  admit(
    accountId: string,
    emails: ArrivedEmail[],
    scope: NotificationScope,
    now: number,
  ): Candidate[] {
    if (!this.primed.has(accountId)) {
      // Launch backlog: record it so a later resync can't announce it.
      for (const email of emails) this.decided.add(email.id);
      return [];
    }

    const announce: Candidate[] = [];
    for (const email of emails) {
      if (this.decided.has(email.id) || this.pending.has(email.id)) continue;
      const labels = email.labelIds ?? [];
      // Mail the user has already read (elsewhere, or in an earlier session)
      // isn't an arrival, and neither is their own sent mail.
      if (!labels.includes("INBOX") || !labels.includes("UNREAD")) continue;
      if (labels.includes("SENT")) continue;

      const candidate: Candidate = {
        emailId: email.id,
        threadId: email.threadId,
        accountId: email.accountId ?? accountId,
        from: email.from,
        subject: email.subject,
        queuedAt: now,
      };

      if (scope === "all") {
        this.decided.add(email.id);
        announce.push(candidate);
      } else if (email.analysis?.needsReply) {
        // Already analyzed — a resync of mail the prefetcher reached first.
        this.decided.add(email.id);
        announce.push(candidate);
      } else if (email.analysis) {
        this.decided.add(email.id); // analyzed, not priority: never announce
      } else {
        this.pending.set(email.id, candidate);
      }
    }
    this.expire(now);
    return announce;
  }

  /**
   * An analysis verdict landed. Returns the candidate to announce, or null —
   * for mail that isn't priority, was never waiting, or that `stillUnread`
   * says the user has read in the meantime.
   */
  resolveAnalysis(
    emailId: string,
    needsReply: boolean,
    stillUnread: () => boolean,
  ): Candidate | null {
    const candidate = this.pending.get(emailId);
    if (!candidate) return null;
    this.pending.delete(emailId);
    this.decided.add(emailId);
    if (!needsReply) return null;
    // The user may have read it in Gmail while we were deliberating.
    if (!stillUnread()) return null;
    return candidate;
  }

  private expire(now: number): void {
    const cutoff = now - PENDING_TTL_MS;
    for (const [id, candidate] of this.pending) {
      if (candidate.queuedAt < cutoff) {
        this.pending.delete(id);
        this.decided.add(id);
      }
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }

  reset(): void {
    this.primed.clear();
    this.pending.clear();
    this.decided.clear();
  }
}

/** The display name in a From header, falling back to the raw address. */
export function displayName(from: string): string {
  const named = from.match(/^\s*"?([^"<]+?)"?\s*</);
  return named ? named[1].trim() : from.trim();
}

export type NotificationPlan =
  | { kind: "none" }
  | { kind: "individual"; items: Candidate[] }
  | { kind: "summary"; count: number; senders: string[] };

/**
 * How a batch is presented: a notification each up to `maxIndividual`, and a
 * single summary beyond it — twelve popups at once is worse than one.
 */
export function planBatch(batch: Candidate[], maxIndividual: number): NotificationPlan {
  if (batch.length === 0) return { kind: "none" };
  if (batch.length <= maxIndividual) return { kind: "individual", items: batch };
  return {
    kind: "summary",
    count: batch.length,
    senders: [...new Set(batch.map((c) => displayName(c.from)))].slice(0, 3),
  };
}
