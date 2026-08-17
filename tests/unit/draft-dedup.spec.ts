/**
 * Auto-draft thread deduplication.
 *
 * The regression this was written for: a sponsorship thread where the agent
 * correctly declined to draft ("the ball is with the agency"), which recorded
 * the thread as handled. Two days later the agency replied with the answer —
 * and that message never got a draft, because the thread was remembered as
 * done rather than the message being remembered as done.
 */
import { test, expect } from "@playwright/test";
import { selectThreadsNeedingDraft } from "../../src/main/utils/draft-dedup";

const email = (id: string, threadId: string, date: string) => ({ id, threadId, date });

const NONE = new Map<string, string>();
const NOBLOCK = new Set<string>();

test.describe("selectThreadsNeedingDraft", () => {
  test("picks the newest message in each thread", () => {
    const out = selectThreadsNeedingDraft(
      [
        email("old", "t1", "Thu, 13 Aug 2026 10:00:00 +0000"),
        email("new", "t1", "Sun, 16 Aug 2026 10:00:00 +0000"),
        email("other", "t2", "Fri, 14 Aug 2026 10:00:00 +0000"),
      ],
      NOBLOCK,
      NONE,
    );
    expect(out.map((e) => e.id).sort()).toEqual(["new", "other"]);
  });

  test("a new reply reopens a thread the agent declined to draft for", () => {
    // The exact regression. "declined" was queued and produced no draft; the
    // thread is therefore not blocked, only recorded as handled for that one
    // message. The later reply must still get through.
    const handled = new Map([["t1", "declined"]]);
    const out = selectThreadsNeedingDraft(
      [
        email("declined", "t1", "Thu, 13 Aug 2026 10:00:00 +0000"),
        email("reply", "t1", "Sun, 16 Aug 2026 10:00:00 +0000"),
      ],
      NOBLOCK,
      handled,
    );
    expect(out.map((e) => e.id)).toEqual(["reply"]);
  });

  test("the same message is not queued twice", () => {
    const handled = new Map([["t1", "only"]]);
    const out = selectThreadsNeedingDraft(
      [email("only", "t1", "Thu, 13 Aug 2026 10:00:00 +0000")],
      NOBLOCK,
      handled,
    );
    expect(out).toEqual([]);
  });

  test("a thread with a real draft stays blocked even when new mail arrives", () => {
    // A draft already exists for the thread, so the user has something to work
    // from — a second one would be a duplicate, not a fix.
    const out = selectThreadsNeedingDraft(
      [
        email("old", "t1", "Thu, 13 Aug 2026 10:00:00 +0000"),
        email("new", "t1", "Sun, 16 Aug 2026 10:00:00 +0000"),
      ],
      new Set(["t1"]),
      NONE,
    );
    expect(out).toEqual([]);
  });

  test("in-flight work blocks the thread regardless of the handled map", () => {
    const out = selectThreadsNeedingDraft(
      [email("new", "t1", "Sun, 16 Aug 2026 10:00:00 +0000")],
      new Set(["t1"]),
      new Map([["t1", "something-else"]]),
    );
    expect(out).toEqual([]);
  });

  test("threads are independent", () => {
    const out = selectThreadsNeedingDraft(
      [
        email("a2", "t1", "Sun, 16 Aug 2026 10:00:00 +0000"),
        email("b1", "t2", "Sun, 16 Aug 2026 10:00:00 +0000"),
      ],
      NOBLOCK,
      new Map([["t1", "a2"]]),
    );
    expect(out.map((e) => e.id)).toEqual(["b1"]);
  });

  test("an unparseable date does not throw or win the newest slot", () => {
    // Header dates come off the wire and are not always valid.
    const out = selectThreadsNeedingDraft(
      [email("junk", "t1", "not a date"), email("real", "t1", "Sun, 16 Aug 2026 10:00:00 +0000")],
      NOBLOCK,
      NONE,
    );
    expect(out.map((e) => e.id)).toEqual(["real"]);
  });

  test("no candidates is not an error", () => {
    expect(selectThreadsNeedingDraft([], NOBLOCK, NONE)).toEqual([]);
  });
});
