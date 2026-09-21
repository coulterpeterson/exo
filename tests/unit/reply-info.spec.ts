/**
 * Unit tests for src/shared/reply-info.ts — the single reply/forward pre-fill
 * builder used by both the main process (compose:get-reply-info) and the
 * renderer's instant inline reply.
 *
 * The motivating bug: a Google Group rewrites From to the group address and
 * puts the real sender in Reply-To. Replying to From bounced.
 */
import { test, expect } from "@playwright/test";
import {
  buildReplyInfo,
  computeReplyRecipients,
  parseAddressList,
  replyTargets,
} from "../../src/shared/reply-info";

const groupEmail = {
  id: "msg-1",
  threadId: "thread-1",
  subject: "MINI PC REVIEW COOPERATION",
  from: "'赖一航' via Maplespace General <contact@choosemaple.space>",
  replyTo: "赖一航 <yihang.lai@acemagic.com>",
  to: '"contact@maplespace.ca" <contact@maplespace.ca>',
  date: "2026-09-15T05:59:00Z",
  body: "<p>Hello</p>",
};

const directEmail = {
  id: "msg-2",
  threadId: "thread-2",
  subject: "Hi",
  from: "Sarah Johnson <sarah@example.com>",
  to: "me@example.com, Bob <bob@example.com>",
  cc: "Carol <carol@example.com>",
  date: "2026-09-15T05:59:00Z",
  body: "",
};

test.describe("replyTargets", () => {
  test("uses Reply-To over From when present", () => {
    expect(replyTargets(groupEmail)).toEqual(["yihang.lai@acemagic.com"]);
  });

  test("falls back to From without Reply-To", () => {
    expect(replyTargets(directEmail)).toEqual(["sarah@example.com"]);
  });

  test("supports a multi-address Reply-To", () => {
    expect(replyTargets({ ...directEmail, replyTo: "a@example.com, B <b@example.com>" })).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  test("ignores an empty Reply-To header", () => {
    expect(replyTargets({ ...directEmail, replyTo: "" })).toEqual(["sarah@example.com"]);
  });
});

test.describe("computeReplyRecipients", () => {
  test("reply goes only to the Reply-To address", () => {
    expect(computeReplyRecipients(groupEmail, "reply", ["contact@maplespace.ca"])).toEqual({
      to: ["yihang.lai@acemagic.com"],
      cc: [],
    });
  });

  test("reply-all never CCs the list From address, the reply target or the user", () => {
    const { to, cc } = computeReplyRecipients(groupEmail, "reply-all", [
      "coulter@maplespace.ca",
      "contact@maplespace.ca",
    ]);
    expect(to).toEqual(["yihang.lai@acemagic.com"]);
    expect(cc).toEqual([]);
  });

  test("reply-all CCs everyone else, deduped and case-insensitive", () => {
    const { to, cc } = computeReplyRecipients(
      { ...directEmail, cc: "Carol <carol@example.com>, BOB <Bob@example.com>" },
      "reply-all",
      ["ME@example.com"],
    );
    expect(to).toEqual(["sarah@example.com"]);
    expect(cc).toEqual(["bob@example.com", "carol@example.com"]);
  });

  test("forward has no recipients", () => {
    expect(computeReplyRecipients(directEmail, "forward")).toEqual({ to: [], cc: [] });
  });
});

test.describe("parseAddressList", () => {
  test("handles quoted display names containing commas", () => {
    expect(parseAddressList('"Cronin, Brian" <brian@ex.com>, Jane <jane@ex.com>')).toEqual([
      "brian@ex.com",
      "jane@ex.com",
    ]);
  });

  test("returns [] for undefined", () => {
    expect(parseAddressList(undefined)).toEqual([]);
  });
});

test.describe("buildReplyInfo", () => {
  test("reply pre-fills Reply-To, Re: subject and a blockquoted quote", () => {
    const info = buildReplyInfo(groupEmail, "reply", ["contact@maplespace.ca"]);
    expect(info.to).toEqual(["yihang.lai@acemagic.com"]);
    expect(info.subject).toBe("Re: MINI PC REVIEW COOPERATION");
    expect(info.threadId).toBe("thread-1");
    expect(info.inReplyTo).toBe("msg-1");
    expect(info.quotedBody).toContain('<blockquote class="gmail_quote"');
    expect(info.quotedBody).toContain("<p>Hello</p>");
    expect(info.attribution).toMatch(/^On .*, .*choosemaple\.space.* wrote:$/);
    expect(info.forwardedAttachments).toBeUndefined();
  });

  test("does not double the Re: prefix", () => {
    expect(buildReplyInfo({ ...directEmail, subject: "RE: Hi" }, "reply").subject).toBe("RE: Hi");
  });

  test("forward pre-fills Fwd: subject, no recipients and carries attachments", () => {
    const attachments = [{ id: "a1", filename: "deck.pdf", mimeType: "application/pdf", size: 1 }];
    const info = buildReplyInfo({ ...directEmail, attachments }, "forward");
    expect(info.to).toEqual([]);
    expect(info.cc).toEqual([]);
    expect(info.subject).toBe("Fwd: Hi");
    expect(info.quotedBody).not.toContain("<blockquote");
    expect(info.attribution).toContain("Attachments: deck.pdf");
    expect(info.forwardedAttachments).toEqual(attachments);
  });

  test("escapes HTML in the attribution line", () => {
    const info = buildReplyInfo({ ...directEmail, from: "<script>x</script>" }, "reply");
    expect(info.attribution).toContain("&lt;script&gt;");
  });
});
