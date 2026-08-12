/**
 * Regression coverage for the "session expired banner never clears" bug.
 *
 * The banner used to clear only when the auth:reauth IPC returned success, so a
 * failure in the bookkeeping *after* a successful token exchange left a valid,
 * actively-syncing account stuck behind the banner until restart. A successful
 * sync now retires it on its own.
 */
import { test, expect } from "@playwright/test";
import { ExpiredAccountTracker } from "../../src/main/utils/expired-accounts";

test.describe("ExpiredAccountTracker", () => {
  test("marks an account expired exactly once", () => {
    const t = new ExpiredAccountTracker();
    expect(t.markExpired("default")).toBe(true);
    // Auth errors repeat every sync cycle while a token is dead; only the first
    // should push an IPC event to the renderer.
    expect(t.markExpired("default")).toBe(false);
    expect(t.isExpired("default")).toBe(true);
  });

  test("a successful sync clears an expired account", () => {
    const t = new ExpiredAccountTracker();
    t.markExpired("default");
    expect(t.markSyncResult("default", true)).toBe(true);
    expect(t.isExpired("default")).toBe(false);
  });

  test("only the first successful sync reports a change", () => {
    const t = new ExpiredAccountTracker();
    t.markExpired("default");
    t.markSyncResult("default", true);
    // Every later cycle also succeeds — but the banner is already gone, so
    // these must not spam token-restored events at the renderer.
    expect(t.markSyncResult("default", true)).toBe(false);
    expect(t.markSyncResult("default", true)).toBe(false);
  });

  test("a failed sync leaves the account expired", () => {
    const t = new ExpiredAccountTracker();
    t.markExpired("default");
    expect(t.markSyncResult("default", false)).toBe(false);
    expect(t.isExpired("default")).toBe(true);
  });

  test("a successful sync on a healthy account is a no-op", () => {
    const t = new ExpiredAccountTracker();
    expect(t.markSyncResult("default", true)).toBe(false);
  });

  test("accounts are tracked independently", () => {
    const t = new ExpiredAccountTracker();
    t.markExpired("default");
    t.markExpired("work");
    expect(t.markSyncResult("default", true)).toBe(true);
    expect(t.isExpired("work")).toBe(true);
  });

  test("an account can expire again after being cleared", () => {
    const t = new ExpiredAccountTracker();
    t.markExpired("default");
    t.markSyncResult("default", true);
    expect(t.markExpired("default")).toBe(true);
    expect(t.isExpired("default")).toBe(true);
  });

  test("explicit clear reports whether it changed anything", () => {
    const t = new ExpiredAccountTracker();
    // reauth success clears directly; on an account that was never flagged
    // there's nothing to tell the renderer about.
    expect(t.clear("default")).toBe(false);
    t.markExpired("default");
    expect(t.clear("default")).toBe(true);
  });
});
