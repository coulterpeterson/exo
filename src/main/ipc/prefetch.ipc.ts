import { ipcMain, BrowserWindow } from "electron";
import { prefetchService, type PrefetchProgress } from "../services/prefetch-service";
import {
  getEmail,
  clearInboxAnalyses,
  clearInboxPendingDraftsAndTraces,
  clearInboxArchiveReady,
} from "../db";
import { agentCoordinator } from "../agents/agent-coordinator";
import type { IpcResponse } from "../../shared/types";
import { createLogger } from "../services/logger";

const log = createLogger("prefetch-ipc");

// Get the main window for sending IPC events
function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

// Notify renderer when an email is analyzed
export function notifyEmailAnalyzed(emailId: string): void {
  const window = getMainWindow();
  if (!window) return;

  const email = getEmail(emailId);
  if (email) {
    window.webContents.send("prefetch:email-analyzed", email);
  }
}

// Notify renderer when a thread's archive-readiness is determined
export function notifyArchiveReady(
  threadId: string,
  accountId: string,
  isReady: boolean,
  reason: string,
): void {
  const window = getMainWindow();
  if (!window) return;

  window.webContents.send("archive-ready:result", { threadId, accountId, isReady, reason });
}

export function registerPrefetchIpc(): void {
  // Set up progress listener to emit events to renderer
  prefetchService.onProgress((progress) => {
    const window = getMainWindow();
    if (window) {
      window.webContents.send("prefetch:progress", progress);
    }
  });

  // Get current progress
  ipcMain.handle("prefetch:status", async (): Promise<IpcResponse<PrefetchProgress>> => {
    try {
      const progress = prefetchService.getProgress();
      return { success: true, data: progress };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Start processing all pending emails
  ipcMain.handle("prefetch:process-all", async (): Promise<IpcResponse<void>> => {
    try {
      // Start processing in background (non-blocking)
      prefetchService.processAllPending().catch((error) => {
        log.error({ err: error }, "[Prefetch] Error in processAllPending");
      });
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Queue specific emails for processing
  ipcMain.handle(
    "prefetch:queue-emails",
    async (_, { emailIds }: { emailIds: string[] }): Promise<IpcResponse<void>> => {
      try {
        await prefetchService.queueEmails(emailIds);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Re-analyze the whole inbox from scratch.
  //
  // processAllPending() only picks up emails with no stored analysis, so once a
  // row exists — including a "Failed to parse" placeholder written when the LLM
  // returned something unusable — that email is never revisited. Recovering from
  // a bad batch previously required editing the analysis prompt just to trigger
  // the clear-and-rerun path buried in settings:set-prompts.
  //
  // Clears analyses plus everything derived from them (drafts, agent traces,
  // archive-ready), then re-queues. Inbox only; archived mail is left alone.
  ipcMain.handle("prefetch:reanalyze-all", async (): Promise<IpcResponse<{ cleared: number }>> => {
    try {
      // Cancel in-flight auto-drafts first, or their saveDraft messages land
      // after the clear and resurrect rows we just deleted.
      agentCoordinator.cancelByPrefix("auto-draft-");

      const cleared = clearInboxAnalyses();
      const { draftsCleared, tracesCleared } = clearInboxPendingDraftsAndTraces();
      const archiveCleared = clearInboxArchiveReady();
      log.info(
        `[Prefetch] Re-analyze requested — cleared ${cleared} analyses, ${draftsCleared} drafts, ${tracesCleared} traces, ${archiveCleared} archive-ready`,
      );

      // clearForRerun (not reset) so the DB-seeded processedDrafts set doesn't
      // re-block the emails whose drafts we just cleared.
      prefetchService.clearForRerun();

      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("prompts:changed", {
          analysisChanged: true,
          draftChanged: true,
          archiveReadyChanged: true,
          agentDrafterChanged: false,
        });
      }

      prefetchService.processAllPending().catch((error) => {
        log.error({ err: error }, "[Prefetch] Error re-processing after re-analyze");
      });

      return { success: true, data: { cleared } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Clear prefetch state
  ipcMain.handle("prefetch:clear", async (): Promise<IpcResponse<void>> => {
    try {
      prefetchService.clear();
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });
}
