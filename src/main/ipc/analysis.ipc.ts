import { ipcMain, BrowserWindow } from "electron";
import { EmailAnalyzer } from "../services/email-analyzer";
import {
  getEmail,
  saveAnalysis,
  getInboxEmails,
  getAccounts,
  getMemories,
  saveMemory,
} from "../db";
import { getConfig, getFeatureModelConfig } from "./settings.ipc";
import {
  MoveToPriorityRequestSchema,
  USER_PRIORITY_REASON,
  type IpcResponse,
  type DashboardEmail,
  type Email,
  type MoveToPriorityResult,
} from "../../shared/types";
import { buildPriorityRuleMemories, isDuplicateRule } from "../services/priority-rules";
import { prefetchService } from "../services/prefetch-service";
import { randomUUID } from "crypto";
import { DEMO_INBOX_EMAILS, DEMO_EXPECTED_ANALYSIS } from "../demo/fake-inbox";
import {
  learnFromPriorityOverrideWithReason,
  learnFromPriorityOverrideInferred,
} from "../services/analysis-edit-learner";
import { stripQuotedContent } from "../services/strip-quoted-content";
import { createLogger } from "../services/logger";

const log = createLogger("analysis-ipc");

const isTestMode = process.env.EXO_TEST_MODE === "true";
const isDemoMode = process.env.EXO_DEMO_MODE === "true";
const useFakeData = isTestMode || isDemoMode;

// Per-account learning queue to prevent race conditions on concurrent overrides
const learningQueues = new Map<string, Promise<void>>();

function enqueueLearn(accountId: string, fn: () => Promise<unknown>): void {
  const prev = learningQueues.get(accountId) ?? Promise.resolve();
  const next: Promise<void> = prev.then(async () => {
    await fn().catch((err) => log.error({ err: err }, "[Analysis] Learning failed"));
  });
  learningQueues.set(accountId, next);
  // Clean up completed promises to prevent memory leak
  next.then(() => {
    if (learningQueues.get(accountId) === next) {
      learningQueues.delete(accountId);
    }
  });
}

let analyzer: EmailAnalyzer | null = null;

function getAnalyzer(): EmailAnalyzer {
  if (!analyzer) {
    const config = getConfig();
    const { model, provider } = getFeatureModelConfig("analysis");
    analyzer = new EmailAnalyzer(model, config.analysisPrompt, provider);
  }
  return analyzer;
}

export function resetAnalyzer(): void {
  analyzer = null;
}

function getUserEmail(accountId?: string): string | undefined {
  const accounts = getAccounts();
  if (accountId) {
    return accounts.find((a) => a.id === accountId)?.email;
  }
  return accounts.find((a) => a.isPrimary)?.email ?? accounts[0]?.email;
}

export function registerAnalysisIpc(): void {
  // Analyze a single email
  ipcMain.handle(
    "analysis:analyze",
    async (_, { emailId }: { emailId: string }): Promise<IpcResponse<DashboardEmail>> => {
      // In demo mode, return pre-computed analysis
      if (useFakeData) {
        const email = DEMO_INBOX_EMAILS.find((e) => e.id === emailId);
        if (!email) {
          return { success: false, error: "Email not found in demo data" };
        }

        const expectedAnalysis = DEMO_EXPECTED_ANALYSIS[emailId];
        if (!expectedAnalysis) {
          return { success: false, error: "No analysis available for this demo email" };
        }

        // Simulate a slight delay like real analysis would have
        await new Promise((resolve) => setTimeout(resolve, 500));

        const dashboardEmail: DashboardEmail = {
          ...email,
          analysis: {
            needsReply: expectedAnalysis.needsReply,
            reason: expectedAnalysis.reason,
            analyzedAt: Date.now(),
          },
        };

        return { success: true, data: dashboardEmail };
      }

      try {
        const email = getEmail(emailId);
        if (!email) {
          return { success: false, error: "Email not found" };
        }

        const analyzerInstance = getAnalyzer();
        const userEmail = getUserEmail(email.accountId);
        const emailForAnalysis: Email = {
          id: email.id,
          threadId: email.threadId,
          subject: email.subject,
          from: email.from,
          to: email.to,
          date: email.date,
          body: email.body ?? "",
          snippet: email.snippet,
        };

        const result = await analyzerInstance.analyze(emailForAnalysis, userEmail, email.accountId);

        // Save analysis to database
        saveAnalysis(emailId, result.needs_reply, result.reason);

        // Return updated email with analysis
        const updatedEmail = getEmail(emailId);
        if (!updatedEmail) {
          return { success: false, error: "Failed to retrieve updated email" };
        }

        return { success: true, data: updatedEmail };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Analyze multiple emails
  ipcMain.handle(
    "analysis:analyze-batch",
    async (_, { emailIds }: { emailIds: string[] }): Promise<IpcResponse<DashboardEmail[]>> => {
      // In demo mode, return pre-computed analysis for all
      if (useFakeData) {
        const results: DashboardEmail[] = [];
        for (const emailId of emailIds) {
          const email = DEMO_INBOX_EMAILS.find((e) => e.id === emailId);
          if (!email) continue;

          const expectedAnalysis = DEMO_EXPECTED_ANALYSIS[emailId];
          results.push({
            ...email,
            analysis: expectedAnalysis
              ? {
                  needsReply: expectedAnalysis.needsReply,
                  reason: expectedAnalysis.reason,
                  analyzedAt: Date.now(),
                }
              : undefined,
          });
        }
        return { success: true, data: results };
      }

      try {
        const analyzerInstance = getAnalyzer();
        const results: DashboardEmail[] = [];

        for (const emailId of emailIds) {
          const email = getEmail(emailId);
          if (!email) continue;

          // Skip if already analyzed
          if (email.analysis) {
            results.push(email);
            continue;
          }

          const userEmail = getUserEmail(email.accountId);
          const emailForAnalysis: Email = {
            id: email.id,
            threadId: email.threadId,
            subject: email.subject,
            from: email.from,
            to: email.to,
            date: email.date,
            body: email.body ?? "",
            snippet: email.snippet,
          };

          try {
            const result = await analyzerInstance.analyze(
              emailForAnalysis,
              userEmail,
              email.accountId,
            );
            saveAnalysis(emailId, result.needs_reply, result.reason);

            const updatedEmail = getEmail(emailId);
            if (updatedEmail) {
              results.push(updatedEmail);
            }
          } catch (analyzeError) {
            log.error({ err: analyzeError }, `Failed to analyze email ${emailId}`);
            // Continue with other emails
          }
        }

        // Return only inbox emails to keep memory usage low
        return { success: true, data: getInboxEmails() };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Override an email's needs-reply classification and learn from the correction.
  // (Historical name "override-priority" kept for backwards compat — emails are now
  // simply Priority/Other, no high/medium/low.)
  ipcMain.handle(
    "analysis:override-priority",
    async (
      _,
      {
        emailId,
        newNeedsReply,
        reason,
      }: {
        emailId: string;
        newNeedsReply: boolean;
        reason?: string;
      },
    ): Promise<IpcResponse<{ analysisUpdated: boolean }>> => {
      try {
        const email = getEmail(emailId);
        if (!email) {
          return { success: false, error: "Email not found" };
        }

        // Capture original analysis before overwriting
        const originalAnalysis = email.analysis;
        const originalNeedsReply = originalAnalysis?.needsReply ?? false;

        // Update the analysis in DB
        saveAnalysis(emailId, newNeedsReply, originalAnalysis?.reason ?? "User override");

        log.info(
          `[Analysis] Needs-reply overridden for ${emailId}: ${originalNeedsReply} → ${newNeedsReply}`,
        );

        // Learn from the override in the background (don't block the UI)
        const accountId = email.accountId ?? "default";
        const senderMatch = email.from.match(/<([^>]+)>/) ?? email.from.match(/([^\s<]+@[^\s>]+)/);
        const senderEmail = senderMatch ? senderMatch[1].toLowerCase() : email.from.toLowerCase();
        const senderDomain = senderEmail.includes("@") ? senderEmail.split("@")[1] : "";

        // Truncate body for the learner
        const bodySnippet = stripQuotedContent(email.body ?? "").slice(0, 500);

        const sendLearnedEvent = (payload: {
          promoted: Array<{
            id: string;
            content: string;
            scope: string;
            scopeValue: string | null;
          }>;
          draftMemoriesCreated: number;
        }) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (win) win.webContents.send("analysis-override:learned", payload);
        };

        if (reason && reason.trim()) {
          // Explicit reason → save directly as promoted memory
          enqueueLearn(accountId, async () => {
            const { memory, saved } = await learnFromPriorityOverrideWithReason({
              accountId,
              senderEmail,
              senderDomain,
              reason: reason.trim(),
              emailId,
            });
            if (saved) {
              sendLearnedEvent({
                promoted: [
                  {
                    id: memory.id,
                    content: memory.content,
                    scope: memory.scope,
                    scopeValue: memory.scopeValue ?? null,
                  },
                ],
                draftMemoriesCreated: 0,
              });
            }
          });
        } else {
          // No reason → infer patterns via Claude
          enqueueLearn(accountId, async () => {
            const result = await learnFromPriorityOverrideInferred({
              emailId,
              accountId,
              senderEmail,
              senderDomain,
              subject: email.subject,
              bodySnippet,
              originalNeedsReply,
              newNeedsReply,
            });
            if (result.promoted.length > 0 || result.draftMemoriesCreated > 0) {
              sendLearnedEvent(result);
            }
          });
        }

        return { success: true, data: { analysisUpdated: true } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // "Move to Priority": the user is correcting the analyzer. Reclassify the
  // emails now, optionally save a rule so the analyzer gets it right next
  // time, and start a reply draft the same way auto-drafting would have if
  // the analyzer had called it Priority in the first place.
  //
  // Unlike override-priority, nothing is inferred: the user said exactly how
  // far the lesson should reach (this email / this sender / emails like this).
  ipcMain.handle(
    "analysis:move-to-priority",
    async (_, payload: unknown): Promise<IpcResponse<MoveToPriorityResult>> => {
      const parsed = MoveToPriorityRequestSchema.safeParse(payload);
      if (!parsed.success) {
        return { success: false, error: `Invalid request: ${parsed.error.message}` };
      }
      const { emailIds, rule } = parsed.data;

      try {
        const emails = emailIds
          .map((id) => getEmail(id))
          .filter((e): e is DashboardEmail => e !== null);
        if (emails.length === 0) return { success: false, error: "Emails not found" };

        for (const email of emails) {
          saveAnalysis(email.id, true, USER_PRIORITY_REASON);
        }

        // Save the lesson, skipping anything an existing rule already says.
        const learned: MoveToPriorityResult["learned"] = [];
        const candidates = buildPriorityRuleMemories(rule, emails, randomUUID, Date.now());
        for (const memory of candidates) {
          if (isDuplicateRule(memory, getMemories(memory.accountId, "analysis"))) continue;
          saveMemory(memory);
          learned.push({
            id: memory.id,
            content: memory.content,
            scope: memory.scope,
            scopeValue: memory.scopeValue,
          });
        }

        // Draft a reply for anything that doesn't have one yet — a Priority
        // email is one the user means to answer.
        let draftsQueued = 0;
        for (const email of emails) {
          if (email.draft?.body) continue;
          if (prefetchService.forceQueueAgentDraft(email.id, { userRequested: true })) {
            draftsQueued++;
          }
        }

        log.info(
          { count: emails.length, rule: rule.kind, learned: learned.length, drafts: draftsQueued },
          "[Analysis] Moved to Priority",
        );

        if (learned.length > 0) {
          const win = BrowserWindow.getAllWindows()[0];
          if (win) {
            win.webContents.send("analysis-override:learned", {
              promoted: learned,
              draftMemoriesCreated: 0,
            });
          }
        }

        return {
          success: true,
          data: { moved: emails.map((e) => e.id), learned, draftsQueued },
        };
      } catch (error) {
        log.error({ err: error }, "[Analysis] Move to Priority failed");
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );
}
