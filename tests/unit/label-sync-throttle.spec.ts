/**
 * Label sync rides on the mail sync cycle, which runs every 30s. These pin the
 * throttle that keeps that from turning into a steady drip of labels.list calls,
 * and the manual-Refresh escape hatch that bypasses it.
 *
 * Predicate lives in its own module because labels.ipc pulls in Electron,
 * which isn't available under the unit project.
 */
import { test, expect } from "@playwright/test";
import {
  shouldSyncLabels,
  LABEL_SYNC_MIN_INTERVAL_MS,
} from "../../src/main/utils/label-sync-throttle";

const NOW = 1_800_000_000_000;

test.describe("shouldSyncLabels", () => {
  test("syncs when the account has never been synced", () => {
    expect(shouldSyncLabels(undefined, NOW, false)).toBe(true);
  });

  test("skips a second sync inside the throttle window", () => {
    expect(shouldSyncLabels(NOW - 30_000, NOW, false)).toBe(false);
  });

  test("syncs again once the window has elapsed", () => {
    expect(shouldSyncLabels(NOW - LABEL_SYNC_MIN_INTERVAL_MS, NOW, false)).toBe(true);
    expect(shouldSyncLabels(NOW - LABEL_SYNC_MIN_INTERVAL_MS - 1, NOW, false)).toBe(true);
  });

  test("is exclusive at the boundary minus one", () => {
    expect(shouldSyncLabels(NOW - (LABEL_SYNC_MIN_INTERVAL_MS - 1), NOW, false)).toBe(false);
  });

  test("force bypasses the throttle entirely", () => {
    // The user pressing Refresh is an explicit "get me current" request, so it
    // must not be swallowed by a sync that happened seconds earlier.
    expect(shouldSyncLabels(NOW, NOW, true)).toBe(true);
    expect(shouldSyncLabels(NOW - 1, NOW, true)).toBe(true);
  });
});
