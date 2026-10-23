/**
 * Draft system-prompt assembly.
 *
 * Extracted from draft-pipeline.ts (which imports the DB and Electron, so it
 * can't be unit tested) specifically so the ordering below is covered by a test
 * that exercises the real function rather than a copy of it — the previous
 * spec re-implemented this logic and could therefore pass while the pipeline
 * was broken.
 */

import type { McpGuidance } from "../../shared/mcp-guidance";

export interface DraftPromptParts {
  draftPrompt: string;
  styleContext?: string;
  memoryContext?: string;
  /** The user's instructions for their connected MCP services. */
  connectedServices?: McpGuidance[];
  instructions?: string;
}

/**
 * The generator can't call tools, but it writes the actual words, so the
 * user's rules for their services ("never name other sponsors", "offer weeks,
 * not days") still bind it. The facts those rules depend on come from the
 * agent, which can query the services, in the additional instructions.
 */
export function formatConnectedServiceRules(services: McpGuidance[]): string {
  if (services.length === 0) return "";
  const sections = services.map((s) => `### ${s.name}\n${s.instructions}`).join("\n\n");
  return [
    "CONNECTED SERVICES:",
    "The user connected these services and gave the rules below. You can't query them yourself; " +
      "the research agent does, and passes what it found in the additional instructions. " +
      "Follow these rules wherever they apply. Never state facts a rule depends on — dates, " +
      "availability, prices — unless the additional instructions supply them; if they don't, " +
      "say you'll confirm rather than guessing.",
    sections,
  ].join("\n\n");
}

/**
 * Layered outermost-first: memory → style → the draft prompt itself, then the
 * connected-service rules, with any agent instructions appended at the very end.
 */
export function assembleDraftPrompt(parts: DraftPromptParts): string {
  let prompt = parts.draftPrompt;
  if (parts.styleContext) {
    prompt = `${parts.styleContext}\n\n${prompt}`;
  }
  if (parts.memoryContext) {
    prompt = `${parts.memoryContext}\n\n${prompt}`;
  }
  const serviceRules = formatConnectedServiceRules(parts.connectedServices ?? []);
  if (serviceRules) {
    prompt = `${prompt}\n\n${serviceRules}`;
  }
  if (parts.instructions) {
    prompt = `${prompt}\n\nADDITIONAL INSTRUCTIONS:\n${parts.instructions}`;
  }
  return prompt;
}
