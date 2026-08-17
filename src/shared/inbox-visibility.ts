/**
 * What belongs in the threaded inbox list the UI is built from.
 *
 * Every list in the app — Priority, Other, Drafts, Snoozed — is a filter over
 * one pool of threads, and that pool used to be "has the INBOX label". Once
 * snoozing started archiving in Gmail, snoozed threads fell out of the pool
 * entirely and the Snoozed tab emptied a second after it appeared, because the
 * tab filters the pool rather than fetching separately.
 *
 * Named and shared so the invariant is visible to whoever adds the next filter:
 * a snoozed thread is deliberately not in the inbox and still has to be here.
 */

interface VisibilityCandidate {
  threadId: string;
  labelIds?: string[] | null;
}

/** Emails with no labels at all predate label syncing and are treated as inbox. */
export function hasInboxLabel(email: VisibilityCandidate): boolean {
  if (!email.labelIds) return true;
  return email.labelIds.includes("INBOX");
}

export function isVisibleInThreadList(
  email: VisibilityCandidate,
  snoozedThreadIds: ReadonlySet<string>,
): boolean {
  return (
    hasInboxLabel(email) ||
    email.labelIds?.includes("SENT") === true ||
    snoozedThreadIds.has(email.threadId)
  );
}

/**
 * A thread survives grouping if any message is in the inbox, or the whole
 * thread is snoozed. Sent-only threads belong in the Sent view.
 */
export function isThreadVisible(
  thread: { threadId: string; emails: VisibilityCandidate[] },
  snoozedThreadIds: ReadonlySet<string>,
): boolean {
  return snoozedThreadIds.has(thread.threadId) || thread.emails.some(hasInboxLabel);
}
