/**
 * What survives into the threaded inbox list.
 *
 * The regression: snoozing began archiving in Gmail, and the pool every list
 * filters was "has the INBOX label" — so a snoozed thread vanished from the
 * pool and the Snoozed tab, which is a filter over that pool, showed a count
 * for about a second and then dropped to zero.
 */
import { test, expect } from "@playwright/test";
import {
  hasInboxLabel,
  isThreadVisible,
  isVisibleInThreadList,
} from "../../src/shared/inbox-visibility";

const NONE = new Set<string>();

test.describe("hasInboxLabel", () => {
  test("emails with no labels at all are treated as inbox", () => {
    // Predates label syncing; dropping these would empty older installs.
    expect(hasInboxLabel({ threadId: "t1" })).toBe(true);
    expect(hasInboxLabel({ threadId: "t1", labelIds: null })).toBe(true);
  });

  test("an archived email is not in the inbox", () => {
    expect(hasInboxLabel({ threadId: "t1", labelIds: ["IMPORTANT"] })).toBe(false);
  });
});

test.describe("isVisibleInThreadList", () => {
  test("keeps a snoozed thread that has been archived", () => {
    // The exact shape a Gmail-backed snooze leaves behind: no INBOX, plus the
    // snooze label. Requiring INBOX is what emptied the Snoozed tab.
    const archivedAndSnoozed = { threadId: "t1", labelIds: ["Label_exo_snoozed", "IMPORTANT"] };
    expect(isVisibleInThreadList(archivedAndSnoozed, NONE)).toBe(false);
    expect(isVisibleInThreadList(archivedAndSnoozed, new Set(["t1"]))).toBe(true);
  });

  test("keeps sent messages so threads read as conversations", () => {
    expect(isVisibleInThreadList({ threadId: "t1", labelIds: ["SENT"] }, NONE)).toBe(true);
  });

  test("drops an archived thread nobody snoozed", () => {
    expect(
      isVisibleInThreadList({ threadId: "t1", labelIds: ["IMPORTANT"] }, new Set(["t2"])),
    ).toBe(false);
  });
});

test.describe("isThreadVisible", () => {
  test("a snoozed thread survives even with every message archived", () => {
    const thread = {
      threadId: "t1",
      emails: [
        { threadId: "t1", labelIds: ["Label_exo_snoozed"] },
        { threadId: "t1", labelIds: ["SENT"] },
      ],
    };
    expect(isThreadVisible(thread, NONE)).toBe(false);
    expect(isThreadVisible(thread, new Set(["t1"]))).toBe(true);
  });

  test("one inbox message is enough to keep the thread", () => {
    const thread = {
      threadId: "t1",
      emails: [
        { threadId: "t1", labelIds: ["SENT"] },
        { threadId: "t1", labelIds: ["INBOX"] },
      ],
    };
    expect(isThreadVisible(thread, NONE)).toBe(true);
  });

  test("a sent-only thread belongs in the Sent view, not here", () => {
    const thread = { threadId: "t1", emails: [{ threadId: "t1", labelIds: ["SENT"] }] };
    expect(isThreadVisible(thread, NONE)).toBe(false);
  });
});
