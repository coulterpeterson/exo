/**
 * Whether a thread is a live back-and-forth the user is part of.
 *
 * Auto-drafting keys off the analyzer's needs-reply verdict, which is a
 * judgement about one message. On a running negotiation that verdict is often
 * defensibly "no" — "brand is politely declining for now and proposing to
 * revisit" needs no reply in the abstract — while the user still wants
 * something drafted, because they are mid-conversation with a real person.
 *
 * The signal used here is participation, not content: the user has already
 * written into this thread, and the newest message is somebody else's. A
 * newsletter never satisfies the first; a thread waiting on the other party
 * never satisfies the second. Both are cheap and need no model call.
 */

export interface ThreadMessage {
  from: string;
  date: string;
  labelIds?: string[] | null;
}

function timeOf(date: string): number {
  const t = new Date(date).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Compares the address inside "Name <addr>" rather than the display name. */
function addressOf(from: string): string {
  const angled = from.match(/<([^>]+)>/);
  return (angled ? angled[1] : from).trim().toLowerCase();
}

export function isFromUser(message: ThreadMessage, userEmail?: string): boolean {
  // The SENT label is authoritative and survives display-name changes and
  // send-as aliases, which an address comparison alone would miss.
  if (message.labelIds?.includes("SENT")) return true;
  if (!userEmail) return false;
  return addressOf(message.from) === userEmail.trim().toLowerCase();
}

/**
 * @param messages every message in the thread, in any order.
 * @returns true when the user has written in this thread and is not the last
 *   one to have spoken — i.e. the ball is with them.
 */
export function isConversationalFollowUp(
  messages: readonly ThreadMessage[],
  userEmail?: string,
): boolean {
  if (messages.length === 0) return false;

  let newest: ThreadMessage | null = null;
  let userHasWritten = false;

  for (const message of messages) {
    if (isFromUser(message, userEmail)) userHasWritten = true;
    if (!newest || timeOf(message.date) > timeOf(newest.date)) newest = message;
  }

  if (!userHasWritten || !newest) return false;
  // Drafting a reply to your own last message is never right, and the "Other"
  // bucket contains plenty of threads that are simply waiting on the other side.
  return !isFromUser(newest, userEmail);
}
