/**
 * The PreToolUse hook that makes the agent consider the user's connected-
 * service instructions before it writes (src/main/agents/providers/
 * connected-services-hook.ts), and the filter that decides which instructions
 * are live (src/shared/mcp-guidance.ts).
 *
 * Motivating case: sponsor availability lives in a planner reached over MCP;
 * a drafter that goes straight to generate_draft offers dates without it.
 */
import { test, expect } from "@playwright/test";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  buildConnectedServicesHook,
  CONNECTED_SERVICES_REMINDER,
} from "../../src/main/agents/providers/connected-services-hook";
import { activeMcpGuidance } from "../../src/shared/mcp-guidance";

const GENERATE_DRAFT = "mcp__mail-app-tools__generate_draft";

function setup(serverNames = ["beaverbase"]) {
  const denied: string[] = [];
  const matcher = buildConnectedServicesHook(serverNames, (id) => denied.push(id));
  if (!matcher) throw new Error("expected a hook");
  let n = 0;
  const call = async (toolName: string) => {
    const id = `tool-${++n}`;
    const input: HookInput = {
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: {},
      tool_use_id: id,
      session_id: "s",
      transcript_path: "",
      cwd: "",
    };
    const result = await matcher.hooks[0](input, id, { signal: new AbortController().signal });
    return { id, result };
  };
  return { call, denied, matcher };
}

test.describe("buildConnectedServicesHook", () => {
  test("is not installed when no service has instructions", () => {
    expect(buildConnectedServicesHook([], () => {})).toBeNull();
  });

  test("watches every tool, so service use is seen whatever it's called", () => {
    expect(setup().matcher.matcher).toBeUndefined();
  });

  test("denies the first draft written without consulting a service, once", async () => {
    const { call, denied } = setup();
    const first = await call(GENERATE_DRAFT);
    expect(first.result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: CONNECTED_SERVICES_REMINDER,
      },
    });
    expect(denied).toEqual([first.id]);

    // The agent decided the instructions don't apply and asked again.
    expect((await call(GENERATE_DRAFT)).result).toEqual({});
    expect(denied).toHaveLength(1);
  });

  test("lets the draft through once an instructed service has been used", async () => {
    const { call, denied } = setup();
    await call("mcp__beaverbase__query_database");
    expect((await call(GENERATE_DRAFT)).result).toEqual({});
    expect(denied).toEqual([]);
  });

  test("covers every tool that writes, not just generate_draft", async () => {
    for (const tool of ["compose_new_email", "send_reply", "update_draft", "create_draft"]) {
      const { call, denied } = setup();
      await call(`mcp__mail-app-tools__${tool}`);
      expect(denied, tool).toHaveLength(1);
    }
  });

  test("leaves research alone, and a different server doesn't count as consulting", async () => {
    const { call, denied } = setup();
    expect((await call("mcp__mail-app-tools__read_thread")).result).toEqual({});
    expect((await call("mcp__chrome-devtools__navigate_page")).result).toEqual({});
    await call(GENERATE_DRAFT);
    expect(denied).toHaveLength(1);
  });
});

test.describe("activeMcpGuidance", () => {
  test("keeps instructions only for configured servers with text", () => {
    const servers = { beaverbase: {}, notes: {} };
    const instructions = {
      beaverbase: "  Check the planner.  ",
      notes: "   ",
      removed: "Describes tools nobody has.",
    };
    expect(activeMcpGuidance(servers, instructions)).toEqual([
      { name: "beaverbase", instructions: "Check the planner." },
    ]);
  });

  test("is empty when nothing is configured", () => {
    expect(activeMcpGuidance(undefined, { beaverbase: "x" })).toEqual([]);
    expect(activeMcpGuidance({ beaverbase: {} }, undefined)).toEqual([]);
  });
});
