/**
 * Draft system-prompt assembly.
 *
 * Extracted from draft-pipeline.ts (which imports the DB and Electron, so it
 * can't be unit tested) specifically so the ordering below is covered by a test
 * that exercises the real function rather than a copy of it — the previous
 * spec re-implemented this logic and could therefore pass while the pipeline
 * was broken.
 */

export interface DraftPromptParts {
  draftPrompt: string;
  styleContext?: string;
  memoryContext?: string;
  instructions?: string;
}

/**
 * Layered outermost-first: memory → style → the draft prompt itself, with any
 * agent instructions appended at the very end.
 */
export function assembleDraftPrompt(parts: DraftPromptParts): string {
  let prompt = parts.draftPrompt;
  if (parts.styleContext) {
    prompt = `${parts.styleContext}\n\n${prompt}`;
  }
  if (parts.memoryContext) {
    prompt = `${parts.memoryContext}\n\n${prompt}`;
  }
  if (parts.instructions) {
    prompt = `${prompt}\n\nADDITIONAL INSTRUCTIONS:\n${parts.instructions}`;
  }
  return prompt;
}
