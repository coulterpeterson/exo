/**
 * Turns a "Move to Priority" choice into the analysis memories that teach the
 * analyzer to make the same call next time.
 *
 * Electron-free and database-free so the decisions can be tested directly; the
 * IPC handler does the saving. The memories land in the existing analysis
 * memory store, which the analyzer already reads for every email it
 * classifies (memory-context.ts → buildAnalysisMemoryContext):
 *
 * - "sender" → a person-scoped memory, matched on the sender's address.
 * - "type"   → a category-scoped memory, offered to the analyzer for every
 *              sender with the user's own description as the label, so the
 *              model decides which emails it describes.
 * - "none"   → nothing; the user said this one is an exception.
 */
import type { Memory, MoveToPriorityRule } from "../../shared/types";

export interface PriorityRuleSource {
  accountId?: string;
  from: string;
}

/** Bare, lowercased sender address — the key person-scoped memories match on. */
export function senderAddress(from: string): string {
  const angled = from.match(/<([^>]+)>/);
  if (angled) return angled[1].trim().toLowerCase();
  const bare = from.match(/([^\s<]+@[^\s>]+)/);
  return (bare ? bare[1] : from).trim().toLowerCase();
}

export function buildPriorityRuleMemories(
  rule: MoveToPriorityRule,
  emails: PriorityRuleSource[],
  makeId: () => string,
  now: number,
): Memory[] {
  if (rule.kind === "none" || emails.length === 0) return [];

  const base = {
    source: "priority-override" as const,
    sourceEmailId: null,
    enabled: true,
    memoryType: "analysis" as const,
    createdAt: now,
    updatedAt: now,
  };

  if (rule.kind === "sender") {
    // Only meaningful for a single email: "always from this sender" across a
    // multi-sender selection would be several rules the user never saw.
    if (emails.length !== 1) return [];
    const email = emails[0];
    return [
      {
        ...base,
        id: makeId(),
        accountId: email.accountId ?? "default",
        scope: "person",
        scopeValue: senderAddress(email.from),
        content:
          "Always classify emails from this sender as Priority — the user wants to reply to them.",
      },
    ];
  }

  // "type": one rule per account the emails came from. In the unified inbox a
  // selection can span accounts, and memories are per account.
  const description = rule.description.trim();
  const accounts = [...new Set(emails.map((e) => e.accountId ?? "default"))];
  return accounts.map((accountId) => ({
    ...base,
    id: makeId(),
    accountId,
    scope: "category",
    scopeValue: description,
    content: `Always classify as Priority (needs a reply): ${description}`,
  }));
}

/** An equivalent rule already exists — saving it again would only add noise to the prompt. */
export function isDuplicateRule(candidate: Memory, existing: Memory[]): boolean {
  return existing.some(
    (m) =>
      m.enabled &&
      m.memoryType === candidate.memoryType &&
      m.accountId === candidate.accountId &&
      m.scope === candidate.scope &&
      (m.scopeValue ?? "").toLowerCase() === (candidate.scopeValue ?? "").toLowerCase() &&
      m.content.trim().toLowerCase() === candidate.content.trim().toLowerCase(),
  );
}
