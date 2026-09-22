/**
 * The badge query, kept apart from db/index.ts so it can be exercised against
 * a real in-memory database in tests (db/index.ts imports electron).
 */
import type { NotificationScope } from "../../shared/types";

/**
 * Count inbox threads holding unread mail.
 *
 * Counted over messages in SQL rather than by reusing the renderer's thread
 * grouping: the badge has to be right when no window exists, and a
 * COUNT(DISTINCT thread_id) is cheaper than materializing every thread. A
 * thread with five unread messages counts once.
 *
 * "priority" means the analyzer decided a message in the thread needs a
 * reply — the verdict behind the Priority tab. Mail that hasn't been analyzed
 * yet is therefore not counted in that scope; it joins the count when
 * analysis catches up, which is the same way it joins the Priority tab.
 *
 * Snoozed threads are excluded: they're deliberately out of the inbox until
 * their timer fires.
 */
export function unreadThreadCountSql(scope: NotificationScope, filterByAccount: boolean): string {
  return `SELECT COUNT(DISTINCT e.thread_id) as count
     FROM emails e
     ${scope === "priority" ? "JOIN analyses a ON a.email_id = e.id" : ""}
     WHERE e.label_ids LIKE '%"INBOX"%'
       AND e.label_ids LIKE '%"UNREAD"%'
       ${scope === "priority" ? "AND a.needs_reply = 1" : ""}
       ${filterByAccount ? "AND e.account_id = ?" : ""}
       AND e.thread_id NOT IN (SELECT thread_id FROM snoozed_emails)`;
}
