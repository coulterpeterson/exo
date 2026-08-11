/**
 * Throttle for the Gmail label cache refresh.
 *
 * Label sync piggybacks on the mail sync cycle (every 30s by default) so a
 * label created in Gmail appears without restarting the app. Label sets change
 * far less often than that, so without a throttle this becomes a steady drip of
 * extra labels.list calls per account.
 *
 * Kept dependency-free — labels.ipc transitively imports Electron, which isn't
 * available in the unit test project.
 */
export const LABEL_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

export function shouldSyncLabels(
  lastSyncedAt: number | undefined,
  now: number,
  force: boolean,
): boolean {
  // A manual Refresh is an explicit "get me current" request and must never be
  // swallowed by a sync that happened seconds earlier.
  if (force) return true;
  if (lastSyncedAt === undefined) return true;
  return now - lastSyncedAt >= LABEL_SYNC_MIN_INTERVAL_MS;
}
