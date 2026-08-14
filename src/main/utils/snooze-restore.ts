/**
 * The ordering rule for waking a snoozed thread.
 *
 * Worth isolating because getting it backwards strands mail. Once a snooze puts
 * the thread under a label and out of the inbox, the local row is the only
 * record that it is supposed to come back — so removing the row before Gmail
 * confirms the restore loses the thread quietly: archived, under a label nobody
 * checks, with nothing left to trigger a retry.
 *
 * Dependency-free so the unit suite can reach it; snooze-service imports the
 * database and therefore Electron.
 */

export interface DueSnooze {
  id: string;
  threadId: string;
  accountId: string;
  /**
   * Whether this app archived and labelled the thread when it was snoozed.
   * Rows predating the Gmail-backed snooze are false and must be woken locally
   * only — their threads were never moved.
   */
  gmailManaged?: boolean;
}

/**
 * Restore each due snooze, returning only those that actually made it back.
 *
 * @param restore null when there is no Gmail behind this run (demo, e2e), in
 *   which case every row is simply dropped — the original local-only behaviour.
 * @param remove deletes the local row. Called only after a successful restore.
 * @param onError reports a failure; the row is deliberately left in place so
 *   the next tick retries it.
 */
export async function restoreDueSnoozes<T extends DueSnooze>(
  due: readonly T[],
  restore: ((threadId: string, accountId: string, item: T) => Promise<void>) | null,
  remove: (id: string) => void,
  onError: (error: unknown, item: T) => void,
): Promise<T[]> {
  const restored: T[] = [];

  for (const item of due) {
    if (restore) {
      try {
        await restore(item.threadId, item.accountId, item);
      } catch (error) {
        onError(error, item);
        // No `remove` — one failing thread must not stop the rest, and must
        // still be here next time.
        continue;
      }
    }
    remove(item.id);
    restored.push(item);
  }

  return restored;
}
