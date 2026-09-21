/**
 * Unit tests for the agent's draft-creating tools (src/main/agents/tools/email-tools.ts).
 *
 * Covers the "orphaned draft" bug: the agent answered an open thread with
 * compose_new_email, which writes a standalone local draft with no threadId.
 * The tool now refuses a Re:-subject call while a thread is in context, and
 * generate_draft accepts recipient overrides so the redirected-reply case
 * ("resend to the address that didn't bounce") stays in the thread.
 */
import { test, expect } from "@playwright/test";
import { tools } from "../../src/main/agents/tools/email-tools";
import type { ProxyContext } from "../../src/main/agents/tools/types";

function tool(name: string) {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

function makeCtx(task?: ProxyContext["task"]) {
  const calls: { method: string; args: unknown[] }[] = [];
  const ctx: ProxyContext = {
    db: async (method, ...args) => {
      calls.push({ method, args });
      if (method === "generateDraft") return { body: "generated", to: args[3] };
      if (method === "generateNewEmail") return { body: "new body" };
      return undefined;
    },
    gmail: async () => undefined,
    task,
  };
  return { ctx, calls };
}

const inThread = {
  accountId: "default",
  userEmail: "me@x.com",
  currentEmailId: "e1",
  currentThreadId: "t1",
};

test.describe("compose_new_email guard", () => {
  test("refuses a Re: subject while a thread is open and points at generate_draft", async () => {
    const { ctx, calls } = makeCtx(inThread);
    await expect(
      tool("compose_new_email").execute(
        {
          accountId: "default",
          to: ["flora@iflytalent.info"],
          subject: "Re: Partnership Opportunity with AutoFull",
          instructions: "resend",
        },
        ctx,
      ),
    ).rejects.toThrow(/generate_draft with emailId "e1"/);
    expect(calls).toEqual([]);
  });

  test("is case/whitespace tolerant on the Re: prefix", async () => {
    const { ctx } = makeCtx(inThread);
    await expect(
      tool("compose_new_email").execute(
        { accountId: "default", to: ["a@b.c"], subject: "  RE : hi", instructions: "x" },
        ctx,
      ),
    ).rejects.toThrow(/generate_draft/);
  });

  test("allows a genuinely new subject while a thread is open", async () => {
    const { ctx, calls } = makeCtx(inThread);
    const result = (await tool("compose_new_email").execute(
      {
        accountId: "default",
        to: ["a@b.c"],
        subject: "AutoFull Warranty Inquiry",
        instructions: "x",
      },
      ctx,
    )) as { saved: boolean; draftId: string };
    expect(result.saved).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["generateNewEmail", "saveLocalDraft"]);
  });

  test("allows a Re: subject when nothing is open (inbox-level task)", async () => {
    const { ctx, calls } = makeCtx({ accountId: "default", userEmail: "me@x.com" });
    await tool("compose_new_email").execute(
      { accountId: "default", to: ["a@b.c"], subject: "Re: old topic", instructions: "x" },
      ctx,
    );
    expect(calls.map((c) => c.method)).toEqual(["generateNewEmail", "saveLocalDraft"]);
  });
});

test.describe("generate_draft recipient overrides", () => {
  test("passes to/cc/bcc through to the pipeline", async () => {
    const { ctx, calls } = makeCtx(inThread);
    await tool("generate_draft").execute(
      {
        accountId: "default",
        emailId: "e1",
        instructions: "resend",
        to: ["flora@iflytalent.info"],
        cc: ["contact@maplespace.ca"],
      },
      ctx,
    );
    expect(calls).toEqual([
      {
        method: "generateDraft",
        args: [
          "e1",
          "default",
          "resend",
          ["flora@iflytalent.info"],
          ["contact@maplespace.ca"],
          undefined,
        ],
      },
    ]);
  });

  test("omits overrides when not given so the pipeline derives Reply-To / From", async () => {
    const { ctx, calls } = makeCtx(inThread);
    await tool("generate_draft").execute({ accountId: "default", emailId: "e1" }, ctx);
    expect(calls[0].args).toEqual(["e1", "default", undefined, undefined, undefined, undefined]);
  });
});
