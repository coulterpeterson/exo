import type { HookCallback, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";

/** Mail-app tools that write words someone else will read. */
const DRAFT_WRITING_TOOLS = new Set(
  [
    "generate_draft",
    "create_draft",
    "update_draft",
    "compose_new_email",
    "forward_email",
    "send_reply",
  ].map((name) => `mcp__mail-app-tools__${name}`),
);

export const CONNECTED_SERVICES_REMINDER =
  "Before writing, check the Connected Services instructions in your system prompt. " +
  "If any of them applies to this email, use that service's tools first and pass what you " +
  "find in your instructions for the draft. If none applies, make the same call again.";

/**
 * Build a PreToolUse hook that stops the agent once, before it writes, to
 * consider the instructions the user gave for their connected services.
 *
 * The instructions are in the system prompt, but the background drafter works
 * through its own step list and can go straight to generate_draft — so a
 * sponsor pitch got dates offered without the planner ever being read. The
 * first draft-writing call in a run that hasn't used any instructed service is
 * denied with a reminder; the agent then consults the service or repeats the
 * call, which goes through. It is a reminder rather than a requirement because
 * whether the instructions apply (a sponsor pitch, not a receipt) is a
 * judgment about the email.
 *
 * `onDeny` gets the denied call's id: a denied tool never reaches its handler,
 * so the caller has to close it in the trace itself.
 *
 * Returns null when no connected service has instructions.
 */
export function buildConnectedServicesHook(
  serverNames: string[],
  onDeny: (toolUseId: string) => void,
): HookCallbackMatcher | null {
  if (serverNames.length === 0) return null;
  const prefixes = serverNames.map((name) => `mcp__${name}__`);
  let consulted = false;
  let reminded = false;

  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolName = input.tool_name;
    if (prefixes.some((prefix) => toolName.startsWith(prefix))) {
      consulted = true;
      return {};
    }
    if (consulted || reminded || !DRAFT_WRITING_TOOLS.has(toolName)) return {};
    reminded = true;
    onDeny(input.tool_use_id);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: CONNECTED_SERVICES_REMINDER,
      },
    };
  };

  // No matcher: every tool passes through, so service use is seen as it happens.
  return { hooks: [hook] };
}
