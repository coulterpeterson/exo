/**
 * The Gmail half of snooze.
 *
 * Gmail's own snooze is not reachable from the API — it uses an internal
 * SNOOZED system label plus server-side scheduling, and users.threads.modify
 * rejects SNOOZED as a label id. So a snooze that survives on your phone has to
 * be built out of ordinary parts: apply a user label, drop INBOX (an archive),
 * and put INBOX back when the timer fires. The timer itself stays local,
 * because there is nothing on Gmail's side to hold it.
 *
 * Deliberately a separate module from snooze-service. email-sync imports
 * snoozeService to unsnooze on reply, so a service that reached back into the
 * sync layer for a client would close an import cycle. snooze.ipc injects this
 * instead, and snooze-service keeps working without it — which is what demo and
 * e2e runs rely on to stay purely local.
 */
import { getEmailSyncService } from "../ipc/sync.ipc";
import { getEmailsByThread, getLabels, applyLabelDeltaToThread } from "../db";
import { syncLabelsForAccount } from "../ipc/labels.ipc";
import { createLogger } from "./logger";

const log = createLogger("snooze-gmail");

/** "/" makes Gmail nest it under an Exo group in the sidebar. */
export const SNOOZE_LABEL_NAME = "Exo/Snoozed";

/**
 * Resolved label ids, per account.
 *
 * Cleared whenever a modify call fails, so a label the user deleted in Gmail
 * costs one failed snooze rather than every snooze until restart.
 */
const labelIdCache = new Map<string, string>();

export function _clearSnoozeLabelCacheForTesting(): void {
  labelIdCache.clear();
}

function findSnoozeLabelId(accountId: string): string | null {
  return getLabels(accountId).find((l) => l.name === SNOOZE_LABEL_NAME)?.id ?? null;
}

/**
 * The id of this account's snooze label, creating it on first use.
 *
 * The catch is not just defensive: the label may already exist because another
 * Exo install created it, in which case Gmail 409s and the right answer is to
 * re-read the list rather than fail the snooze.
 */
export async function ensureSnoozeLabelId(accountId: string): Promise<string> {
  const cached = labelIdCache.get(accountId);
  if (cached) return cached;

  const known = findSnoozeLabelId(accountId);
  if (known) {
    labelIdCache.set(accountId, known);
    return known;
  }

  const client = getEmailSyncService().getClientForAccount(accountId);
  if (!client) throw new Error("Account is not connected");

  try {
    const created = await client.createLabel(SNOOZE_LABEL_NAME);
    labelIdCache.set(accountId, created.id);
    // Refresh the cache so the label picker shows it without waiting a cycle.
    await syncLabelsForAccount(accountId, { force: true });
    log.info(`[Snooze] Created ${SNOOZE_LABEL_NAME} for account ${accountId}`);
    return created.id;
  } catch (error) {
    await syncLabelsForAccount(accountId, { force: true });
    const existing = findSnoozeLabelId(accountId);
    if (existing) {
      labelIdCache.set(accountId, existing);
      return existing;
    }
    throw error;
  }
}

async function modifyThread(
  threadId: string,
  accountId: string,
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<void> {
  const client = getEmailSyncService().getClientForAccount(accountId);
  if (!client) throw new Error("Account is not connected");

  const messageIds = getEmailsByThread(threadId, accountId).map((e) => e.id);
  if (messageIds.length === 0) return;

  try {
    await client.batchModifyLabels(messageIds, { addLabelIds, removeLabelIds });
  } catch (error) {
    // Most likely cause is a label id that no longer exists in Gmail.
    labelIdCache.delete(accountId);
    throw error;
  }
  // Mirror locally so the list updates without waiting for the next sync.
  applyLabelDeltaToThread(threadId, accountId, addLabelIds, removeLabelIds);
}

export interface SnoozeGmailGateway {
  apply(threadId: string, accountId: string): Promise<void>;
  restore(threadId: string, accountId: string): Promise<void>;
  clearLabel(threadId: string, accountId: string): Promise<void>;
}

export const snoozeGmailGateway: SnoozeGmailGateway = {
  /**
   * Label and archive in one batchModify. One call rather than two so there is
   * no window where the thread is labelled but still sitting in the inbox.
   */
  async apply(threadId, accountId) {
    const labelId = await ensureSnoozeLabelId(accountId);
    await modifyThread(threadId, accountId, [labelId], ["INBOX"]);
  },

  async restore(threadId, accountId) {
    const labelId = await ensureSnoozeLabelId(accountId);
    await modifyThread(threadId, accountId, ["INBOX"], [labelId]);
  },

  /**
   * A reply already pulled the thread back into the inbox — Gmail delivers new
   * messages to INBOX regardless of the thread being archived — so the only
   * thing left is the now-misleading label.
   */
  async clearLabel(threadId, accountId) {
    const labelId = await ensureSnoozeLabelId(accountId);
    await modifyThread(threadId, accountId, [], [labelId]);
  },
};
