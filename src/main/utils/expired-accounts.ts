/**
 * Tracks which accounts are showing the "session expired" banner.
 *
 * Split out of sync.ipc (which imports Electron, so it can't be unit tested)
 * because the transitions are the whole fix: the banner used to clear only when
 * the auth:reauth IPC returned success, so any failure in the bookkeeping after
 * a successful token exchange stranded a valid, actively-syncing account behind
 * a permanent "session expired" banner.
 *
 * Both methods return whether the state actually changed, so callers emit one
 * IPC event per real transition instead of on every sync cycle.
 */
export class ExpiredAccountTracker {
  private expired = new Set<string>();

  /** @returns true if this account was not already flagged. */
  markExpired(accountId: string): boolean {
    if (this.expired.has(accountId)) return false;
    this.expired.add(accountId);
    return true;
  }

  /**
   * Record the outcome of a sync cycle.
   *
   * A cycle that reached Gmail proves the account is authenticated, whatever
   * the re-auth round-trip reported.
   *
   * @returns true if this cleared a previously-expired account.
   */
  markSyncResult(accountId: string, ok: boolean): boolean {
    if (!ok) return false;
    return this.expired.delete(accountId);
  }

  /** @returns true if this cleared a previously-expired account. */
  clear(accountId: string): boolean {
    return this.expired.delete(accountId);
  }

  isExpired(accountId: string): boolean {
    return this.expired.has(accountId);
  }
}
