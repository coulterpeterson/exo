/**
 * Which "Other" threads still deserve a draft.
 *
 * The case this was built for: a sponsorship thread where the brand replied
 * "declining for now, let's revisit". The analyzer said no reply needed — a
 * defensible read of that one message — so nothing was drafted, even though
 * the user had been trading messages with a real person for weeks.
 *
 * Precision matters more than recall: drafting for a newsletter costs a model
 * call and clutters the list, so every test here is really asking whether the
 * participation signal holds up.
 */
import { test, expect } from "@playwright/test";
import { isConversationalFollowUp, isFromUser } from "../../src/main/utils/conversational-thread";

const ME = "coulter@maples.example";
const inbound = (date: string, from = "brand@desky.example") => ({ from, date });
const sent = (date: string) => ({ from: `Coulter <${ME}>`, date, labelIds: ["SENT"] });

test.describe("isFromUser", () => {
  test("trusts the SENT label over the address", () => {
    // Send-as aliases and display-name changes both break address matching.
    expect(
      isFromUser({ from: "Coulter <alias@other.example>", date: "", labelIds: ["SENT"] }, ME),
    ).toBe(true);
  });

  test("compares the address inside angle brackets, not the display name", () => {
    expect(isFromUser({ from: `Coulter Peterson <${ME}>`, date: "" }, ME)).toBe(true);
    // A sender who puts the user's address in their display name is not the user.
    expect(isFromUser({ from: `"${ME}" <spoof@evil.example>`, date: "" }, ME)).toBe(false);
  });

  test("is case- and whitespace-insensitive", () => {
    expect(isFromUser({ from: "  <COULTER@Maples.Example>  ", date: "" }, ME)).toBe(true);
  });

  test("without a known user address, only the label counts", () => {
    expect(isFromUser({ from: "anyone@example.com", date: "" }, undefined)).toBe(false);
    expect(isFromUser({ from: "anyone@example.com", date: "", labelIds: ["SENT"] })).toBe(true);
  });
});

test.describe("isConversationalFollowUp", () => {
  test("the motivating case: user has replied, brand answered last", () => {
    const thread = [
      inbound("Mon, 10 Aug 2026 09:00:00 +0000"),
      sent("Tue, 11 Aug 2026 09:00:00 +0000"),
      inbound("Wed, 12 Aug 2026 09:00:00 +0000"),
    ];
    expect(isConversationalFollowUp(thread, ME)).toBe(true);
  });

  test("no draft when the user spoke last", () => {
    // The ball is with the other side; drafting would reply to yourself.
    const thread = [
      inbound("Mon, 10 Aug 2026 09:00:00 +0000"),
      sent("Tue, 11 Aug 2026 09:00:00 +0000"),
    ];
    expect(isConversationalFollowUp(thread, ME)).toBe(false);
  });

  test("no draft for a thread the user has never written in", () => {
    // Newsletters, receipts and cold outreach all look like this.
    const thread = [
      inbound("Mon, 10 Aug 2026 09:00:00 +0000", "news@list.example"),
      inbound("Wed, 12 Aug 2026 09:00:00 +0000", "news@list.example"),
    ];
    expect(isConversationalFollowUp(thread, ME)).toBe(false);
  });

  test("message order does not matter", () => {
    const ordered = [
      inbound("Mon, 10 Aug 2026 09:00:00 +0000"),
      sent("Tue, 11 Aug 2026 09:00:00 +0000"),
      inbound("Wed, 12 Aug 2026 09:00:00 +0000"),
    ];
    expect(isConversationalFollowUp([...ordered].reverse(), ME)).toBe(true);
  });

  test("an empty thread is not a conversation", () => {
    expect(isConversationalFollowUp([], ME)).toBe(false);
  });

  test("unparseable dates do not crash or invent a newest message", () => {
    const thread = [sent("nonsense"), inbound("Wed, 12 Aug 2026 09:00:00 +0000")];
    expect(isConversationalFollowUp(thread, ME)).toBe(true);
  });

  test("falls back to the SENT label when the account address is unknown", () => {
    // Unified-inbox paths can hand us an email whose account we can't resolve.
    const thread = [
      sent("Tue, 11 Aug 2026 09:00:00 +0000"),
      inbound("Wed, 12 Aug 2026 09:00:00 +0000"),
    ];
    expect(isConversationalFollowUp(thread, undefined)).toBe(true);
  });
});
