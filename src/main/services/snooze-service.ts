import {
  getDueSnoozedEmails,
  unsnoozeEmail,
  getAllSnoozedEmails,
  snoozeEmail as dbSnoozeEmail,
  unsnoozeByThread as dbUnsnoozeByThread,
  getSnoozedEmails as dbGetSnoozedEmails,
  getSnoozedByThread as dbGetSnoozedByThread,
} from "../db";
import type { SnoozedEmail } from "../../shared/types";
import { randomUUID } from "crypto";
import { createLogger } from "./logger";
import { restoreDueSnoozes } from "../utils/snooze-restore";

const log = createLogger("snooze");

const CHECK_INTERVAL_MS = 30_000; // Check every 30 seconds

export type SnoozeCallback = (snoozedEmails: SnoozedEmail[]) => void;

/**
 * The Gmail side of a snooze, injected rather than imported.
 *
 * Optional on purpose: with no gateway the service behaves exactly as it did
 * before Gmail was involved — purely local — which is what demo mode and the
 * e2e suite run against.
 */
export interface SnoozeGateway {
  apply(threadId: string, accountId: string): Promise<void>;
  restore(threadId: string, accountId: string): Promise<void>;
  clearLabel(threadId: string, accountId: string): Promise<void>;
}

class SnoozeService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private onUnsnooze: SnoozeCallback | null = null;
  private gateway: SnoozeGateway | null = null;
  /** Guards against a slow Gmail call letting two ticks overlap. */
  private checking = false;

  /**
   * Set callback for when emails are unsnoozed (timer expired).
   */
  setOnUnsnooze(callback: SnoozeCallback): void {
    this.onUnsnooze = callback;
  }

  setGateway(gateway: SnoozeGateway | null): void {
    this.gateway = gateway;
  }

  /**
   * Start the periodic check for due snoozed emails.
   */
  start(): void {
    if (this.intervalId) return;

    log.info("[Snooze] Starting snooze service (check interval: 30s)");
    // Don't check immediately — no renderer windows exist yet to receive
    // the unsnoozed IPC event. The renderer's snooze:list call handles
    // expired snoozes on startup. The periodic timer handles ongoing expiry.
    this.intervalId = setInterval(() => {
      void this.checkDueSnoozedEmails();
    }, CHECK_INTERVAL_MS);
  }

  /**
   * Stop the periodic check.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      log.info("[Snooze] Snooze service stopped");
    }
  }

  /**
   * Snooze a thread until the specified time.
   *
   * Gmail first, then the local row. If Gmail refuses, nothing is written and
   * the caller gets the error — the same contract archive and "move to" already
   * have. Snoozing locally anyway would hide the thread in Exo while leaving it
   * in the inbox everywhere else, which is the divergence this feature exists
   * to remove.
   */
  async snooze(
    emailId: string,
    threadId: string,
    accountId: string,
    snoozeUntil: number,
  ): Promise<SnoozedEmail> {
    if (this.gateway) {
      await this.gateway.apply(threadId, accountId);
    }

    const id = randomUUID();
    // Remove any existing snooze for this thread first
    dbUnsnoozeByThread(threadId, accountId);
    dbSnoozeEmail(id, emailId, threadId, accountId, snoozeUntil);

    const snoozeDate = new Date(snoozeUntil);
    log.info(`[Snooze] Snoozed thread ${threadId} until ${snoozeDate.toLocaleString()}`);

    return {
      id,
      emailId,
      threadId,
      accountId,
      snoozeUntil,
      snoozedAt: Date.now(),
    };
  }

  /**
   * Manually unsnooze a thread (user cancels snooze).
   *
   * Gmail first for the same reason as snooze: if the inbox restore fails, the
   * thread must stay snoozed in Exo so the timer still owns putting it back.
   */
  async unsnooze(threadId: string, accountId: string): Promise<void> {
    if (this.gateway) {
      await this.gateway.restore(threadId, accountId);
    }
    dbUnsnoozeByThread(threadId, accountId);
    log.info(`[Snooze] Manually unsnoozed thread ${threadId}`);
  }

  /**
   * Get all snoozed emails for an account.
   */
  getSnoozedEmails(accountId: string): SnoozedEmail[] {
    return dbGetSnoozedEmails(accountId);
  }

  /**
   * Get snooze info for a specific thread.
   */
  getSnoozedByThread(threadId: string, accountId: string): SnoozedEmail | null {
    return dbGetSnoozedByThread(threadId, accountId);
  }

  /**
   * Get all snoozed emails across all accounts.
   */
  getAllSnoozed(): SnoozedEmail[] {
    return getAllSnoozedEmails();
  }

  /**
   * Unsnooze any threads that received new emails (replies).
   * Called during sync when new messages arrive.
   */
  unsnoozeForReplies(threadIds: string[], accountId: string): SnoozedEmail[] {
    const unsnoozed: SnoozedEmail[] = [];
    for (const threadId of threadIds) {
      const snoozeInfo = dbGetSnoozedByThread(threadId, accountId);
      if (snoozeInfo) {
        dbUnsnoozeByThread(threadId, accountId);
        unsnoozed.push(snoozeInfo);
        log.info(`[Snooze] Unsnoozed thread ${threadId} — new reply received`);
      }
    }
    // Fire-and-forget, and deliberately not awaited: Gmail already delivered
    // the reply to INBOX, so the thread is back where it belongs and only the
    // now-misleading label is left. Nothing downstream depends on it, and this
    // runs inside a sync pass that must not block on label writes.
    if (this.gateway) {
      for (const s of unsnoozed) {
        this.gateway.clearLabel(s.threadId, s.accountId).catch((err) => {
          log.error({ err, threadId: s.threadId }, "[Snooze] Failed to clear label after reply");
        });
      }
    }

    if (unsnoozed.length > 0 && this.onUnsnooze) {
      this.onUnsnooze(unsnoozed);
    }
    return unsnoozed;
  }

  /**
   * Put every due snooze back in the inbox, and return the ones that made it.
   *
   * A row is only deleted once Gmail has confirmed. Deleting first would strand
   * the message: archived, under a label nobody looks at, with the only record
   * that it should have come back now gone. Leaving the row means the next tick
   * tries again, which is what a disconnected account or a transient 5xx wants.
   *
   * Shared by the 30s timer and by snooze:list — the latter handles snoozes
   * that came due while the app was closed, and needs the identical rule.
   *
   * @param accountId restrict to one account; the caller that lists a single
   *   account leaves the rest to the timer.
   */
  async processDue(accountId?: string): Promise<SnoozedEmail[]> {
    const dueEmails = getDueSnoozedEmails().filter(
      (s) => accountId === undefined || s.accountId === accountId,
    );
    if (dueEmails.length === 0) return [];

    log.info(`[Snooze] ${dueEmails.length} snoozed email(s) are due`);

    const gateway = this.gateway;
    return restoreDueSnoozes(
      dueEmails,
      gateway ? (threadId, acct) => gateway.restore(threadId, acct) : null,
      unsnoozeEmail,
      (err, item) =>
        log.error(
          { err, threadId: item.threadId },
          "[Snooze] Could not restore to inbox — keeping the snooze so it retries",
        ),
    );
  }

  /** Timer tick. Skipped while a previous tick is still awaiting Gmail. */
  private async checkDueSnoozedEmails(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const restored = await this.processDue();
      if (restored.length > 0 && this.onUnsnooze) {
        this.onUnsnooze(restored);
      }
    } finally {
      this.checking = false;
    }
  }
}

export const snoozeService = new SnoozeService();
