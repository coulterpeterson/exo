/**
 * Recipients handed to nodemailer when building outgoing MIME
 * (src/main/utils/address-formatting.ts → GmailClient.buildMimeMessage).
 *
 * Motivating incident: replies to agent-drafted emails went out addressed to
 * `Daniel Yu <"Daniel Yu  daniel.yu"@sevensmarketing.com>` and bounced. The
 * draft held "Daniel Yu <daniel.yu@…>" and the whole string was passed to
 * nodemailer as the bare address. Built with real nodemailer, since its
 * handling of the address field is the thing that went wrong.
 */
import { test, expect } from "@playwright/test";
import { createTransport } from "nodemailer";
import { toMailAddresses } from "../../src/main/utils/address-formatting";

async function toHeader(to: string[], recipientNames?: Record<string, string>): Promise<string> {
  const transport = createTransport({ streamTransport: true, buffer: true });
  const info = await transport.sendMail({
    from: "me@example.com",
    to: toMailAddresses(to, recipientNames),
    subject: "x",
    text: "y",
  });
  const header = info.message.toString().match(/^To: (.*)$/m);
  if (!header) throw new Error("no To header");
  return header[1];
}

test.describe("toMailAddresses", () => {
  const names = { "daniel.yu@sevensmarketing.com": "Daniel Yu" };

  test("a pre-formatted recipient with a known name keeps a bare address", async () => {
    expect(await toHeader(["Daniel Yu <daniel.yu@sevensmarketing.com>"], names)).toBe(
      "Daniel Yu <daniel.yu@sevensmarketing.com>",
    );
  });

  test("a bare recipient gets its display name", async () => {
    expect(await toHeader(["daniel.yu@sevensmarketing.com"], names)).toBe(
      "Daniel Yu <daniel.yu@sevensmarketing.com>",
    );
  });

  test("the map's name wins over the one in the string, matched case-insensitively", async () => {
    expect(await toHeader(["Dan <Daniel.Yu@sevensmarketing.com>"], names)).toBe(
      "Daniel Yu <Daniel.Yu@sevensmarketing.com>",
    );
  });

  test("recipients without a known name pass through unchanged", async () => {
    expect(await toHeader(["Jessie <jessie@adjinfluencer.com>", "a@b.com"], names)).toBe(
      "Jessie <jessie@adjinfluencer.com>, a@b.com",
    );
    expect(await toHeader(["Jessie <jessie@adjinfluencer.com>"])).toBe(
      "Jessie <jessie@adjinfluencer.com>",
    );
  });

  test("non-ASCII names are encoded, never folded into the address", async () => {
    const header = await toHeader(["赖一航 <yihang.lai@acemagic.com>"], {
      "yihang.lai@acemagic.com": "赖一航",
    });
    expect(header).toMatch(/^=\?UTF-8\?.+\?= <yihang\.lai@acemagic\.com>$/);
  });
});
