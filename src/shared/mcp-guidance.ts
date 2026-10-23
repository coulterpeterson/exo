export interface McpGuidance {
  name: string;
  instructions: string;
}

/**
 * The user's per-server instructions, for servers that are actually
 * configured. An instruction left behind for a removed server would describe
 * tools nobody has, so it is dropped, as is blank text.
 */
export function activeMcpGuidance(
  servers: Record<string, unknown> | undefined,
  instructions: Record<string, string> | undefined,
): McpGuidance[] {
  const configured = servers ?? {};
  return Object.entries(instructions ?? {})
    .filter(([name, text]) => name in configured && text.trim())
    .map(([name, text]) => ({ name, instructions: text.trim() }));
}
