import { ipcMain, BrowserWindow } from "electron";
import { snoozeService } from "../services/snooze-service";
import type { IpcResponse, SnoozedEmail } from "../../shared/types";
import { createLogger } from "../services/logger";
import { snoozeGmailGateway } from "../services/snooze-gmail";

const log = createLogger("snooze-ipc");

const useFakeData = process.env.EXO_TEST_MODE === "true" || process.env.EXO_DEMO_MODE === "true";

export function registerSnoozeIpc(): void {
  // Set up the unsnooze callback to broadcast to renderer
  snoozeService.setOnUnsnooze((unsnoozedEmails) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("snooze:unsnoozed", { emails: unsnoozedEmails });
    }
  });

  // Demo and e2e runs have no Gmail behind them, so they keep the original
  // purely-local snooze rather than failing on a client that isn't there.
  if (!useFakeData) {
    snoozeService.setGateway(snoozeGmailGateway);
  }

  // Start the snooze timer service
  snoozeService.start();

  // Snooze a thread
  ipcMain.handle(
    "snooze:snooze",
    async (
      _event,
      {
        emailId,
        threadId,
        accountId,
        snoozeUntil,
      }: {
        emailId: string;
        threadId: string;
        accountId: string;
        snoozeUntil: number;
      },
    ): Promise<IpcResponse<SnoozedEmail>> => {
      try {
        const result = await snoozeService.snooze(emailId, threadId, accountId, snoozeUntil);

        // Broadcast snooze event to all windows
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("snooze:snoozed", { snoozedEmail: result });
        }

        return { success: true, data: result };
      } catch (error) {
        log.error({ err: error }, "[Snooze IPC] Failed to snooze");
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to snooze email",
        };
      }
    },
  );

  // Manually unsnooze a thread
  ipcMain.handle(
    "snooze:unsnooze",
    async (
      _event,
      { threadId, accountId }: { threadId: string; accountId: string },
    ): Promise<IpcResponse<void>> => {
      try {
        // Get snooze info before removing so we can include snoozeUntil in the event
        const snoozeInfo = snoozeService.getSnoozedByThread(threadId, accountId);
        await snoozeService.unsnooze(threadId, accountId);

        // Broadcast unsnooze event with snoozeUntil for correct sort positioning
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("snooze:manually-unsnoozed", {
            threadId,
            accountId,
            snoozeUntil: snoozeInfo?.snoozeUntil ?? Date.now(),
          });
        }

        return { success: true, data: undefined };
      } catch (error) {
        log.error({ err: error }, "[Snooze IPC] Failed to unsnooze");
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to unsnooze email",
        };
      }
    },
  );

  // List snoozed emails for an account.
  // Also processes any expired snoozes for this account (handles snoozes
  // that expired while the app was closed) and returns them separately.
  ipcMain.handle(
    "snooze:list",
    async (
      _event,
      { accountId }: { accountId: string },
    ): Promise<IpcResponse<SnoozedEmail[]> & { expired?: SnoozedEmail[] }> => {
      try {
        // Process expired snoozes for this account so the renderer can
        // position them correctly (other accounts are left for the 30s timer).
        // Goes through the service so a snooze that expired while the app was
        // closed is restored to the Gmail inbox, not just dropped locally.
        const expired = await snoozeService.processDue(accountId);
        if (expired.length > 0) {
          log.info(
            `[Snooze IPC] Processed ${expired.length} expired snooze(s) for account ${accountId}`,
          );
        }

        const snoozed = snoozeService.getSnoozedEmails(accountId);
        return { success: true, data: snoozed, expired };
      } catch (error) {
        log.error({ err: error }, "[Snooze IPC] Failed to list snoozed");
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to list snoozed emails",
        };
      }
    },
  );

  // Get snooze info for a specific thread
  ipcMain.handle(
    "snooze:get",
    async (
      _event,
      { threadId, accountId }: { threadId: string; accountId: string },
    ): Promise<IpcResponse<SnoozedEmail | null>> => {
      try {
        const snoozed = snoozeService.getSnoozedByThread(threadId, accountId);
        return { success: true, data: snoozed };
      } catch (error) {
        log.error({ err: error }, "[Snooze IPC] Failed to get snooze");
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get snooze info",
        };
      }
    },
  );
}
