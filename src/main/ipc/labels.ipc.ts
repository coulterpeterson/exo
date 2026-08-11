import { ipcMain, BrowserWindow } from "electron";
import { getEmailSyncService } from "./sync.ipc";
import {
  replaceLabels,
  getLabels,
  applyLabelDeltaToThread,
  getEmailsByThread,
  getAccounts,
} from "../db";
import type { IpcResponse, GmailLabel } from "../../shared/types";
import { createLogger } from "../services/logger";

const log = createLogger("labels-ipc");

const useFakeData = process.env.EXO_TEST_MODE === "true" || process.env.EXO_DEMO_MODE === "true";

/**
 * Pull the label list for one account from Gmail into the local cache.
 *
 * Gmail is the source of truth — a full replace keeps deleted labels from
 * lingering in the picker. Failures are logged and swallowed: labels are a
 * display nicety, and a label-sync outage must not break mail sync.
 */
export async function syncLabelsForAccount(accountId: string): Promise<void> {
  if (useFakeData) return;
  const client = getEmailSyncService().getClientForAccount(accountId);
  if (!client) return;
  try {
    const labels = await client.listLabels();
    replaceLabels(accountId, labels);
    log.info(`[Labels] Synced ${labels.length} labels for account ${accountId}`);
  } catch (error) {
    log.error({ err: error, accountId }, "[Labels] Failed to sync labels");
  }
}

/** Sync labels for every connected account. Called after sync:init. */
export async function syncAllLabels(): Promise<void> {
  for (const account of getAccounts()) {
    await syncLabelsForAccount(account.id);
  }
}

export function registerLabelsIpc(): void {
  ipcMain.handle("labels:list", async (): Promise<IpcResponse<GmailLabel[]>> => {
    try {
      return { success: true, data: getLabels() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  ipcMain.handle(
    "labels:sync",
    async (_, { accountId }: { accountId?: string } = {}): Promise<IpcResponse<GmailLabel[]>> => {
      try {
        if (accountId) {
          await syncLabelsForAccount(accountId);
        } else {
          await syncAllLabels();
        }
        return { success: true, data: getLabels() };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  /**
   * Apply a label delta to whole threads.
   *
   * `archive: true` is what "Move to" means — Gmail has no folders, so moving is
   * adding a label and dropping INBOX in the same batchModify. Doing it in one
   * call (rather than label-then-archive) avoids a window where the thread is
   * labelled but still in the inbox if the second call fails.
   */
  ipcMain.handle(
    "labels:modify-threads",
    async (
      _,
      {
        threadIds,
        accountId,
        addLabelIds = [],
        removeLabelIds = [],
        archive = false,
      }: {
        threadIds: string[];
        accountId: string;
        addLabelIds?: string[];
        removeLabelIds?: string[];
        archive?: boolean;
      },
    ): Promise<IpcResponse<void>> => {
      try {
        const effectiveRemove = archive ? [...removeLabelIds, "INBOX"] : removeLabelIds;
        if (addLabelIds.length === 0 && effectiveRemove.length === 0) {
          return { success: true, data: undefined };
        }

        const messageIds: string[] = [];
        for (const threadId of threadIds) {
          for (const email of getEmailsByThread(threadId, accountId)) {
            messageIds.push(email.id);
          }
        }
        if (messageIds.length === 0) return { success: true, data: undefined };

        if (!useFakeData) {
          const client = getEmailSyncService().getClientForAccount(accountId);
          if (!client) {
            return { success: false, error: "Account is not connected" };
          }
          await client.batchModifyLabels(messageIds, {
            addLabelIds,
            removeLabelIds: effectiveRemove,
          });
        }

        // Mirror the change locally so the UI updates without waiting a sync cycle.
        for (const threadId of threadIds) {
          applyLabelDeltaToThread(threadId, accountId, addLabelIds, effectiveRemove);
        }

        const window = BrowserWindow.getAllWindows()[0];
        if (window) {
          if (archive) {
            window.webContents.send("sync:emails-removed", { accountId, emailIds: messageIds });
          }
          window.webContents.send("labels:threads-changed", {
            accountId,
            threadIds,
            addLabelIds,
            removeLabelIds: effectiveRemove,
          });
        }

        log.info(
          `[Labels] Modified ${threadIds.length} thread(s) (${messageIds.length} messages): +[${addLabelIds.join(",")}] -[${effectiveRemove.join(",")}]`,
        );
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );
}
