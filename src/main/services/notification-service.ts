/**
 * Dock badge and desktop notifications for newly arrived mail.
 *
 * Lives in the main process on purpose. The badge is an app-level thing and
 * has to stay right while the window is closed — on macOS the app keeps
 * running and the 30s sync loop runs with it — so nothing here may depend on
 * a renderer being alive.
 *
 * This file owns timers, the badge and the Notification objects; which mail
 * is worth announcing is decided in notification-policy.ts.
 */
import { app, Notification } from "electron";
import { countUnreadThreads, getEmail } from "../db";
import { getConfig } from "../ipc/settings.ipc";
import { getMainWindow } from "../window";
import { DEFAULT_NOTIFICATION_CONFIG, type NotificationConfig } from "../../shared/types";
import type { DashboardEmail } from "../../shared/types";
import { NotificationPolicy, planBatch, displayName, type Candidate } from "./notification-policy";
import { createLogger } from "./logger";

const log = createLogger("notifications");

const isTestMode = process.env.NODE_ENV === "test" || process.env.EXO_HEADLESS === "true";
const useFakeData = (): boolean =>
  process.env.EXO_TEST_MODE === "true" || process.env.EXO_DEMO_MODE === "true";

/** Individual notifications up to this many per batch; beyond it, one summary. */
const MAX_INDIVIDUAL = 3;
/** Wait this long after the first candidate qualifies before posting, so a
 *  sync that brings in several emails produces one batch rather than a drip. */
const COALESCE_MS = 4000;
/** …but never hold a notification longer than this while mail keeps landing. */
const MAX_COALESCE_MS = 15000;
/** Collapse a burst of label changes (a batch archive) into one recount. */
const BADGE_DEBOUNCE_MS = 250;

class NotificationService {
  private policy = new NotificationPolicy();
  private queue: Candidate[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private firstQueuedAt = 0;
  private badgeTimer: NodeJS.Timeout | null = null;

  private config(): NotificationConfig {
    return { ...DEFAULT_NOTIFICATION_CONFIG, ...(getConfig().notifications ?? {}) };
  }

  /** Never take over a developer's desktop during a test or demo run. */
  private get suppressed(): boolean {
    return isTestMode || useFakeData();
  }

  /**
   * Recompute the badge from the database. Safe to call as often as you like:
   * a batch archive fires one label change per message, so the recount is
   * debounced to the end of the burst.
   */
  refreshBadge(): void {
    if (this.suppressed) return;
    if (this.badgeTimer) clearTimeout(this.badgeTimer);
    this.badgeTimer = setTimeout(() => {
      this.badgeTimer = null;
      this.writeBadge();
    }, BADGE_DEBOUNCE_MS);
  }

  private writeBadge(): void {
    const { badge, scope } = this.config();
    try {
      const count = badge ? countUnreadThreads(scope) : 0;
      app.setBadgeCount(count);
      // Just a number — no addresses, no subjects. Makes "the badge says 7 and
      // my inbox says 2" answerable from a log instead of a guess.
      log.info({ count, scope, badge }, "[Notifications] Badge updated");
    } catch (err) {
      log.error({ err }, "[Notifications] Failed to refresh badge");
    }
  }

  /**
   * An account finished a sync cycle. The first one per account only primes:
   * everything it brought down is pre-existing mail, not an arrival.
   */
  markSyncCycleComplete(accountId: string): void {
    if (this.policy.markPrimed(accountId)) {
      log.info({ account_id: accountId }, "[Notifications] Primed; arrivals now announced");
    }
    this.refreshBadge();
  }

  /** New messages from a sync. */
  handleNewEmails(accountId: string, emails: DashboardEmail[]): void {
    this.refreshBadge();
    if (this.suppressed || !this.config().enabled) return;
    for (const candidate of this.policy.admit(accountId, emails, this.config().scope, Date.now())) {
      this.enqueue(candidate);
    }
  }

  /**
   * The analyzer reached a verdict. Only meaningful in "priority" scope, where
   * a candidate has been waiting for exactly this — when the mail arrived
   * there was no verdict to judge it on.
   */
  onEmailAnalyzed(emailId: string, needsReply: boolean): void {
    this.refreshBadge();
    const candidate = this.policy.resolveAnalysis(emailId, needsReply, () =>
      Boolean(getEmail(emailId)?.labelIds?.includes("UNREAD")),
    );
    if (!candidate) return;
    if (this.suppressed || !this.config().enabled) return;
    this.enqueue(candidate);
  }

  private enqueue(candidate: Candidate): void {
    this.queue.push(candidate);
    if (!this.flushTimer) {
      this.firstQueuedAt = Date.now();
      this.flushTimer = setTimeout(() => this.flush(), COALESCE_MS);
      return;
    }
    // Keep extending while mail keeps landing, but cap the total wait.
    if (Date.now() - this.firstQueuedAt + COALESCE_MS <= MAX_COALESCE_MS) {
      clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.flush(), COALESCE_MS);
    }
  }

  /** True when the user is already looking at the app — the list and badge
   *  are in front of them, so a popup is noise. */
  private appIsFocused(): boolean {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return false;
    return window.isFocused() && window.isVisible() && !window.isMinimized();
  }

  private flush(): void {
    this.flushTimer = null;
    const batch = this.queue;
    this.queue = [];
    if (this.suppressed || !this.config().enabled) return;
    if (!Notification.isSupported()) return;
    if (this.appIsFocused()) {
      log.info({ count: batch.length }, "[Notifications] Suppressed — app is focused");
      return;
    }

    const plan = planBatch(batch, MAX_INDIVIDUAL);
    if (plan.kind === "none") return;

    if (plan.kind === "summary") {
      const scopeLabel = this.config().scope === "priority" ? "priority" : "new";
      const summary = new Notification({
        title: `${plan.count} ${scopeLabel} emails`,
        body: `From ${plan.senders.join(", ")}…`,
      });
      summary.on("click", () => this.focusApp());
      summary.show();
      log.info({ count: plan.count }, "[Notifications] Posted summary");
      return;
    }

    for (const candidate of plan.items) {
      const notification = new Notification({
        title: displayName(candidate.from),
        body: candidate.subject || "(no subject)",
      });
      notification.on("click", () => this.openThread(candidate));
      notification.show();
    }
    log.info({ count: plan.items.length }, "[Notifications] Posted");
  }

  private focusApp(): void {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    app.focus({ steal: true });
  }

  /** Open the message the notification was about. */
  private openThread(candidate: Candidate): void {
    this.focusApp();
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send("notifications:open-thread", {
      emailId: candidate.emailId,
      threadId: candidate.threadId,
      accountId: candidate.accountId,
    });
  }

  /** Clear per-account state on sign-out so a re-add primes again. */
  forgetAccount(accountId: string): void {
    this.policy.forgetAccount(accountId);
    this.refreshBadge();
  }
}

export const notificationService = new NotificationService();
