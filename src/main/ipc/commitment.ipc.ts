import { ipcMain } from "electron";
import { randomUUID } from "crypto";
import {
  saveCommitment,
  getCommitments,
  getCommitment,
  updateCommitment,
  deleteCommitment,
} from "../db";
import { todayISO } from "../utils/date-range";
import type { Commitment, IpcResponse } from "../../shared/types";
import { createLogger } from "../services/logger";

const log = createLogger("commitment-ipc");

/** Fields a caller may supply when creating one by hand. Everything else is
 *  derived here so the renderer can't invent ids, timestamps, or provenance. */
type NewCommitmentInput = Pick<Commitment, "accountId" | "kind" | "statement"> &
  Partial<
    Pick<
      Commitment,
      | "counterpartyEmail"
      | "counterpartyLabel"
      | "subjectMatter"
      | "startDate"
      | "endDate"
      | "datePrecision"
      | "exclusive"
      | "notes"
    >
  >;

function domainOf(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const at = email.lastIndexOf("@");
  return at === -1 ? undefined : email.slice(at + 1).toLowerCase();
}

export function registerCommitmentIpc(): void {
  ipcMain.handle(
    "commitment:list",
    async (_, { accountId }: { accountId: string }): Promise<IpcResponse<Commitment[]>> => {
      try {
        return { success: true, data: getCommitments(accountId) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  ipcMain.handle(
    "commitment:save",
    async (_, input: NewCommitmentInput): Promise<IpcResponse<Commitment>> => {
      try {
        if (!input.statement?.trim()) {
          return { success: false, error: "A commitment needs a description" };
        }
        // A date range needs both ends, or it silently blocks nothing (start
        // missing) or everything after it (end missing but precision exact).
        if (input.startDate && !input.endDate && input.datePrecision === "exact") {
          return { success: false, error: "An exact date range needs an end date" };
        }
        if (input.startDate && input.endDate && input.endDate < input.startDate) {
          return { success: false, error: "End date is before start date" };
        }

        const now = Date.now();
        const commitment: Commitment = {
          id: randomUUID(),
          accountId: input.accountId,
          kind: input.kind,
          status: "active",
          counterpartyEmail: input.counterpartyEmail?.toLowerCase(),
          counterpartyDomain: domainOf(input.counterpartyEmail),
          counterpartyLabel: input.counterpartyLabel,
          subjectMatter: input.subjectMatter,
          statement: input.statement.trim(),
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? null,
          datePrecision: input.datePrecision ?? (input.startDate ? "exact" : "none"),
          exclusive: input.exclusive ?? input.kind === "date_range",
          // Hand-entered facts are ground truth, so they never carry the
          // "unconfirmed" treatment that extracted ones start with.
          confidence: 1,
          confirmed: true,
          source: "manual",
          notes: input.notes,
          createdAt: now,
          updatedAt: now,
        };
        saveCommitment(commitment);
        log.info(`[Commitments] Saved manual commitment ${commitment.id} (${commitment.kind})`);
        return { success: true, data: commitment };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  ipcMain.handle(
    "commitment:update",
    async (
      _,
      { id, updates }: { id: string; updates: Partial<Commitment> },
    ): Promise<IpcResponse<Commitment>> => {
      try {
        const existing = getCommitment(id);
        if (!existing) return { success: false, error: "Commitment not found" };

        const startDate = updates.startDate ?? existing.startDate;
        const endDate = updates.endDate ?? existing.endDate;
        if (startDate && endDate && endDate < startDate) {
          return { success: false, error: "End date is before start date" };
        }

        // Any hand edit is an act of confirmation — the user has now looked at
        // this row, so it should stop being treated as a guess.
        updateCommitment(id, {
          ...updates,
          confirmed: true,
          counterpartyDomain: updates.counterpartyEmail
            ? domainOf(updates.counterpartyEmail)
            : existing.counterpartyDomain,
        });
        return { success: true, data: getCommitment(id)! };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  /** Accept an extracted commitment as-is, without editing it. */
  ipcMain.handle(
    "commitment:confirm",
    async (_, { id }: { id: string }): Promise<IpcResponse<Commitment>> => {
      try {
        const existing = getCommitment(id);
        if (!existing) return { success: false, error: "Commitment not found" };
        updateCommitment(id, { confirmed: true });
        return { success: true, data: getCommitment(id)! };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  ipcMain.handle(
    "commitment:set-status",
    async (
      _,
      { id, status }: { id: string; status: Commitment["status"] },
    ): Promise<IpcResponse<Commitment>> => {
      try {
        const existing = getCommitment(id);
        if (!existing) return { success: false, error: "Commitment not found" };
        updateCommitment(id, { status });
        return { success: true, data: getCommitment(id)! };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  ipcMain.handle(
    "commitment:delete",
    async (_, { id }: { id: string }): Promise<IpcResponse<void>> => {
      try {
        deleteCommitment(id);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  /** Today's date from the main process, so the renderer groups past/upcoming
   *  against the same clock the drafting prompt uses. */
  ipcMain.handle("commitment:today", async (): Promise<IpcResponse<string>> => {
    return { success: true, data: todayISO() };
  });
}
