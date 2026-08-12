/**
 * Shared draft generation pipeline used by both the UI (drafts.ipc.ts)
 * and the agent (agent-coordinator.ts).
 *
 * Centralizes: email lookup → auto-analysis → style context → prompt
 * assembly → DraftGenerator call → DB save.
 */
import { getEmail, saveAnalysis } from "../db";
import { saveDraftAndSync } from "./gmail-draft-sync";
import { getConfig, getFeatureModelConfig } from "../ipc/settings.ipc";
import { getEmailSyncService } from "../ipc/sync.ipc";
import { buildStyleContext } from "./style-profiler";
import { buildMemoryContext } from "./memory-context";
import { buildCommitmentContext } from "./commitment-context";
import { assembleDraftPrompt } from "../utils/draft-prompt";
import { getActiveCommitments } from "../db";
import { todayISO } from "../utils/date-range";
import { textMentionsRange } from "../utils/date-text";
import {
  planConflicts,
  toBlockedWindows,
  verifyConflictsAgainstBody,
  type ConflictPlan,
} from "../utils/commitment-conflict";
import { extractRequestedWindow } from "./requested-window";
import { createLogger } from "./logger";
import { EmailAnalyzer } from "./email-analyzer";
import { DraftGenerator } from "./draft-generator";
import { getAccounts } from "../db";
import { DEFAULT_STYLE_PROMPT } from "../../shared/types";
import type {
  Email,
  AnalysisResult,
  GeneratedDraftResponse,
  DashboardEmail,
} from "../../shared/types";

const log = createLogger("draft-pipeline");

export interface GenerateDraftOptions {
  emailId: string;
  /** Falls back to email.accountId when omitted or empty. */
  accountId?: string;
  /** Optional instructions appended to the prompt (agent use-case). */
  instructions?: string;
}

export interface GenerateForwardOptions {
  emailId: string;
  accountId: string;
  /** Instructions describing who to forward to and why (e.g., "forward to alice@co.com, she handles vendor invoices"). */
  instructions: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
}

/**
 * Shared pipeline setup: look up email, build style/memory context, assemble prompt,
 * create generator. Both reply and forward drafts use this.
 */
async function buildDraftPipeline(
  emailId: string,
  accountId: string | undefined,
  recipientEmail: string,
): Promise<{
  email: DashboardEmail;
  emailForDraft: Email;
  config: ReturnType<typeof getConfig>;
  prompt: string;
  generator: DraftGenerator;
  emailAccountId: string;
}> {
  const email = getEmail(emailId);
  if (!email) throw new Error(`Email not found: ${emailId}`);

  const config = getConfig();
  const emailAccountId = accountId || email.accountId || "default";
  const gmailClient = getEmailSyncService().getClientForAccount(emailAccountId);

  const styleContext = recipientEmail
    ? await buildStyleContext(
        recipientEmail,
        emailAccountId,
        config.stylePrompt ?? DEFAULT_STYLE_PROMPT,
        gmailClient,
      )
    : "";

  const memoryContext = recipientEmail
    ? buildMemoryContext(recipientEmail.toLowerCase(), emailAccountId)
    : "";

  // Account-wide, deliberately not keyed on the recipient — a window promised
  // to one sponsor has to constrain what we offer a different one.
  const commitmentContext = buildCommitmentContext(
    emailAccountId,
    recipientEmail ? recipientEmail.toLowerCase() : undefined,
  );

  const prompt = assembleDraftPrompt({
    draftPrompt: config.draftPrompt,
    styleContext,
    memoryContext,
    commitmentContext,
  });

  const emailForDraft: Email = {
    id: email.id,
    threadId: email.threadId,
    subject: email.subject,
    from: email.from,
    to: email.to,
    cc: email.cc,
    date: email.date,
    body: email.body ?? "",
    snippet: email.snippet,
  };

  const draftsConfig = getFeatureModelConfig("drafts");
  const calendaringConfig = getFeatureModelConfig("calendaring");
  const generator = new DraftGenerator(
    draftsConfig.model,
    prompt,
    calendaringConfig.model,
    draftsConfig.provider,
    calendaringConfig.provider,
  );

  return { email, emailForDraft, config, prompt, generator, emailAccountId };
}

/** Extract an email address from a "Name <email>" or bare "email" string. */
function extractEmail(field: string): string {
  const match = field.match(/<([^>]+)>/) ?? field.match(/([^\s<]+@[^\s>]+)/);
  return match ? match[1] : field;
}

/**
 * Generate a reply draft:
 * 1. Look up email + auto-analyze if needed
 * 2. Build per-recipient style/memory context
 * 3. Generate draft via DraftGenerator (includes EA + sender enrichment)
 * 4. Save draft to DB
 */
export async function generateDraftForEmail(
  opts: GenerateDraftOptions,
): Promise<GeneratedDraftResponse> {
  const { emailId, accountId, instructions } = opts;

  const recipientEmail = (() => {
    const email = getEmail(emailId);
    return email ? extractEmail(email.from) : "";
  })();

  const pipeline = await buildDraftPipeline(emailId, accountId, recipientEmail);
  const { email, emailForDraft, config, emailAccountId } = pipeline;

  // Auto-analyze if not already done (e.g. freshly synced email)
  if (!email.analysis) {
    const analysisConfig = getFeatureModelConfig("analysis");
    const analyzer = new EmailAnalyzer(
      analysisConfig.model,
      config.analysisPrompt ?? undefined,
      analysisConfig.provider,
    );
    const analysisResult = await analyzer.analyze(emailForDraft);
    saveAnalysis(emailId, analysisResult.needs_reply, analysisResult.reason);
    email.analysis = {
      needsReply: analysisResult.needs_reply,
      reason: analysisResult.reason,
      analyzedAt: Date.now(),
    };
  }

  // Work out whether the dates this email asks about collide with something
  // already promised. Done here, before generation, because an avoided window
  // is by definition absent from the finished draft — scanning the output can
  // detect a conflict we failed to avoid, but never one we did.
  //
  // Gated on the account actually having a blocking commitment, so accounts
  // with none never pay for the lookup.
  const today = todayISO();
  const activeCommitments = getActiveCommitments(emailAccountId, today);
  let conflictPlan: ConflictPlan = { conflicts: [], mandate: "" };
  if (toBlockedWindows(activeCommitments).length > 0) {
    const requested = await extractRequestedWindow(
      email.body ?? email.snippet ?? "",
      (email.date ?? "").slice(0, 10) || today,
      { emailId, accountId: emailAccountId },
    );
    conflictPlan = planConflicts(requested, activeCommitments);
  }

  // If the agent provided instructions, or we have a scheduling mandate, build
  // a generator with them appended.
  let { generator } = pipeline;
  if (instructions || conflictPlan.mandate) {
    const extra = [conflictPlan.mandate, instructions].filter(Boolean).join("\n\n");
    const fullPrompt = assembleDraftPrompt({ draftPrompt: pipeline.prompt, instructions: extra });
    const dConfig = getFeatureModelConfig("drafts");
    const cConfig = getFeatureModelConfig("calendaring");
    generator = new DraftGenerator(
      dConfig.model,
      fullPrompt,
      cConfig.model,
      dConfig.provider,
      cConfig.provider,
    );
  }

  const analysis: AnalysisResult = {
    needs_reply: email.analysis.needsReply,
    reason: email.analysis.reason,
  };

  const enableSenderLookup = config.enableSenderLookup ?? true;
  const accounts = getAccounts();
  const userEmail = accounts.find((a) => a.id === emailAccountId)?.email;
  const result = await generator.generateDraft(emailForDraft, analysis, config.ea, {
    enableSenderLookup,
    userEmail,
  });

  // Honesty guard: only claim a window was avoided if the finished draft
  // really doesn't mention it. A card asserting "avoided Mar 3-14" above a body
  // offering Mar 3-14 is worse than no card at all.
  const referenceIso = (email.date ?? "").slice(0, 10) || today;
  const conflictsAvoided = verifyConflictsAgainstBody(conflictPlan.conflicts, (range) =>
    textMentionsRange(result.body, range, referenceIso),
  );
  if (conflictsAvoided.length > 0) {
    log.info(
      `[Commitments] ${conflictsAvoided.length} conflict(s) on draft for ${emailId}: ${conflictsAvoided
        .map((c) => c.outcome)
        .join(", ")}`,
    );
  }

  saveDraftAndSync(
    emailId,
    result.body,
    "pending",
    result.cc,
    result.bcc,
    undefined,
    undefined,
    conflictsAvoided,
  );

  return {
    ...result,
    conflictsAvoided: conflictsAvoided.length > 0 ? conflictsAvoided : undefined,
  };
}

/**
 * Generate a forward draft:
 * 1. Look up email
 * 2. Build per-recipient style/memory context (based on forward recipient)
 * 3. Generate intro text via DraftGenerator
 * 4. Save only the intro text as a draft on the existing email (composeMode="forward")
 *
 * The forwarded message attribution + quoted body are appended at send time,
 * exactly like pressing 'f' in the UI.
 */
export async function generateForwardForEmail(
  opts: GenerateForwardOptions,
): Promise<GeneratedDraftResponse> {
  const { emailId, accountId, instructions, to, cc, bcc } = opts;

  // Style/memory context based on the forward recipient (who we're writing to)
  const primaryRecipient = to && to.length > 0 ? to[0] : "";
  const recipientEmail = extractEmail(primaryRecipient);

  const { emailForDraft, config, generator } = await buildDraftPipeline(
    emailId,
    accountId,
    recipientEmail,
  );

  const enableSenderLookup = config.enableSenderLookup ?? true;
  const result = await generator.generateForward(emailForDraft, instructions, {
    enableSenderLookup,
  });

  // Save only the intro text as a draft on the existing email, just like replies.
  // The forwarded message attribution + quoted body are appended at send time.
  saveDraftAndSync(emailId, result.body, "pending", cc, bcc, "forward", to);

  return result;
}
