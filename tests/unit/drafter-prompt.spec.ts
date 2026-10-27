/**
 * The background drafter's prompt (src/main/utils/drafter-prompt.ts).
 *
 * Motivating incident: a custom drafter prompt described the user in detail
 * but never said to draft, so for days the agent researched each email and
 * then asked "What would you like me to do?" instead of writing anything.
 */
import { test, expect } from "@playwright/test";
import { assembleDrafterPrompt, DRAFT_TASK_DIRECTIVE } from "../../src/main/utils/drafter-prompt";
import { DEFAULT_AGENT_DRAFTER_PROMPT } from "../../src/shared/types";

test.describe("assembleDrafterPrompt", () => {
  test("a custom prompt that never mentions drafting still ends with the task", () => {
    const custom = "You draft for Coulter. WHEN NOT TO DRAFT: flag contracts for review.";
    expect(assembleDrafterPrompt({ agentDrafterPrompt: custom })).toBe(
      custom + DRAFT_TASK_DIRECTIVE,
    );
  });

  test("the task requires generate_draft and a decision note for the agent tab", () => {
    expect(DRAFT_TASK_DIRECTIVE).toContain("always finish by calling generate_draft");
    expect(DRAFT_TASK_DIRECTIVE).toContain("agent tab");
  });

  test("falls back to the default guidance", () => {
    expect(assembleDrafterPrompt({ agentDrafterPrompt: "" })).toBe(
      DEFAULT_AGENT_DRAFTER_PROMPT + DRAFT_TASK_DIRECTIVE,
    );
  });

  test("EA context sits between the guidance and the task, and only when configured", () => {
    const withEa = assembleDrafterPrompt({
      agentDrafterPrompt: "guidance",
      ea: { enabled: true, email: "ea@example.com", name: "Sam" },
    });
    expect(withEa.startsWith("guidance\n\nExecutive Assistant Context:")).toBe(true);
    expect(withEa).toContain("named Sam (ea@example.com)");
    expect(withEa.endsWith(DRAFT_TASK_DIRECTIVE)).toBe(true);

    const disabled = assembleDrafterPrompt({
      agentDrafterPrompt: "guidance",
      ea: { enabled: false, email: "ea@example.com" },
    });
    expect(disabled).toBe("guidance" + DRAFT_TASK_DIRECTIVE);
  });
});
