import { ipcMain } from "electron";
import { llmHealthMonitor } from "../services/llm-health-monitor";
import type { IpcResponse } from "../../shared/types";
import type { LlmHealthStatus } from "../../shared/llm-health";

export function registerLlmHealthIpc(): void {
  // Current status — the renderer asks on load, then listens for
  // llm-health:changed.
  ipcMain.handle(
    "llm-health:get",
    async (): Promise<IpcResponse<LlmHealthStatus>> => ({
      success: true,
      data: llmHealthMonitor.getStatus(),
    }),
  );

  // "Check again" on the banner.
  ipcMain.handle("llm-health:check", async (): Promise<IpcResponse<LlmHealthStatus>> => {
    try {
      return { success: true, data: await llmHealthMonitor.checkNow() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Health check failed",
      };
    }
  });
}
