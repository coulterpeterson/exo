/**
 * Which threads still need an auto-draft.
 *
 * One draft per thread is the rule, but "already handled" has to mean "handled
 * *this* message". The agent is allowed to finish without writing anything —
 * "the ball is with them, nothing to say yet" is a correct answer — which
 * leaves a thread that has been processed and has no draft. Remembering only
 * the thread id then silences it permanently: every later reply looks handled,
 * so the message that finally does need an answer never gets one.
 *
 * Pure and dependency-free because prefetch-service imports the database and
 * therefore Electron. The old spec for this re-implemented the logic inline,
 * which is how the bug above survived having tests.
 */

export interface DraftCandidate {
  id: string;
  threadId: string;
  /** RFC 2822 header date. Unparseable values sort oldest rather than throwing. */
  date: string;
}

function timeOf(date: string): number {
  const t = new Date(date).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * @param blockedThreads threads with a real draft or in-flight agent work.
 *   These are never re-queued regardless of new mail — the draft that exists
 *   (or is being written) already covers the thread.
 * @param handledByThread threadId -> the email id the thread was last queued
 *   for. A thread reappears here only when its newest unanswered message is a
 *   different one, i.e. mail arrived since.
 */
export function selectThreadsNeedingDraft<T extends DraftCandidate>(
  candidates: readonly T[],
  blockedThreads: ReadonlySet<string>,
  handledByThread: ReadonlyMap<string, string>,
): T[] {
  const newestPerThread = new Map<string, T>();

  for (const email of candidates) {
    if (blockedThreads.has(email.threadId)) continue;
    const existing = newestPerThread.get(email.threadId);
    if (!existing || timeOf(email.date) > timeOf(existing.date)) {
      newestPerThread.set(email.threadId, email);
    }
  }

  for (const [threadId, email] of newestPerThread) {
    if (handledByThread.get(threadId) === email.id) {
      newestPerThread.delete(threadId);
    }
  }

  return Array.from(newestPerThread.values());
}
