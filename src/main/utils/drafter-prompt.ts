/**
 * The background drafter's prompt. Pure, so the guarantee below is covered by
 * a unit test (prefetch-service imports the DB and Electron).
 */
import { DEFAULT_AGENT_DRAFTER_PROMPT, type Config, type EAConfig } from "../../shared/types";

/**
 * The drafter's job, appended by the app after the user's drafter prompt.
 *
 * The editable prompt is guidance (who the user is, how they negotiate); the
 * task itself must not depend on it. A custom prompt that described the user
 * in detail but never said to draft left the agent researching every email
 * and then asking "What would you like me to do?" — most auto-drafts silently
 * produced nothing for days. Same split as the archive-ready prompt, whose
 * output format is appended rather than editable.
 */
export const DRAFT_TASK_DIRECTIVE = `

YOUR TASK
Write a reply to this email: always finish by calling generate_draft, passing what you learned in its instructions. Drafting is not optional, even where the guidance above says to flag something for the user instead of drafting — a contract to sign, a first-time rate, a publish date, a doubtful sender. Write the reply they would plausibly send (a polite decline or a holding reply is a valid draft), keeping anything that needs their decision out of the email itself. The only exception is the Executive Assistant rule, if one appears above.

After calling generate_draft, end with a short note to the user listing what needs their decision before sending. It is shown beside the draft in the agent tab. If nothing does, say so in one line.`;

function eaSuffix(ea: EAConfig): string {
  if (!ea.enabled || !ea.email) return "";
  const eaName = ea.name || "the executive assistant";
  return `\n\nExecutive Assistant Context:
The user has an executive assistant${ea.name ? ` named ${ea.name}` : ""} (${ea.email}) who handles scheduling on their behalf.

When you see emails in a thread where ${eaName} is coordinating scheduling with a third party, assess from the email content whether ${eaName} is handling the conversation. If ${eaName} is actively managing the back-and-forth (e.g., proposing times, confirming details) and the email does not require the user's personal input beyond scheduling, do NOT generate a draft. Only draft a reply if the email content directly addresses the user or requires their personal decision or expertise.`;
}

/** The user's drafter prompt (or the default), any EA context, then the task. */
export function assembleDrafterPrompt(config: Pick<Config, "agentDrafterPrompt" | "ea">): string {
  const guidance = config.agentDrafterPrompt || DEFAULT_AGENT_DRAFTER_PROMPT;
  return guidance + (config.ea ? eaSuffix(config.ea) : "") + DRAFT_TASK_DIRECTIVE;
}
