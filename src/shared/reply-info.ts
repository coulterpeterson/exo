/**
 * Reply/forward pre-fill logic shared by the main process (compose:get-reply-info)
 * and the renderer (instant inline reply). One implementation so both paths
 * pick the same recipients — they used to be hand-mirrored copies.
 */
import type { AttachmentMeta, ComposeMode, ReplyInfo } from "./types";
import { splitAddressList } from "./utils/address-parsing";

/** Extract the bare address from `Name <addr>` / `<addr>` / `addr`. */
export function extractAddress(field: string): string {
  const match = field.match(/<([^>]+)>/);
  return (match ? match[1] : field).trim();
}

/** Parse an address header into bare, lowercased-for-comparison addresses (original case kept). */
export function parseAddressList(header: string | undefined): string[] {
  if (!header) return [];
  return splitAddressList(header).map(extractAddress).filter(Boolean);
}

export interface ReplyRecipientSource {
  from: string;
  to: string;
  cc?: string;
  replyTo?: string;
}

/**
 * Who a reply to this message goes to.
 *
 * Reply-To wins over From (RFC 5322 §3.6.2). Mailing lists and Google Groups
 * rewrite From to the list address and put the real sender in Reply-To, so
 * replying to From either bounces or goes to the list instead of the person.
 */
export function replyTargets(email: ReplyRecipientSource): string[] {
  const replyTo = parseAddressList(email.replyTo);
  return replyTo.length > 0 ? replyTo : [extractAddress(email.from)];
}

/**
 * To/CC for a reply. `selfAddresses` is every address the user sends as
 * (account email + aliases) so reply-all never CCs the user.
 */
export function computeReplyRecipients(
  email: ReplyRecipientSource,
  mode: ComposeMode,
  selfAddresses: readonly string[] = [],
): { to: string[]; cc: string[] } {
  if (mode === "forward") return { to: [], cc: [] };

  const to = replyTargets(email);
  if (mode !== "reply-all") return { to, cc: [] };

  // Everyone on the original minus: the reply targets (already in To), the
  // original sender (a list address when Reply-To is set) and ourselves.
  const exclude = new Set([
    ...to.map((a) => a.toLowerCase()),
    extractAddress(email.from).toLowerCase(),
    ...selfAddresses.map((a) => a.toLowerCase()),
  ]);
  const cc: string[] = [];
  for (const addr of [...parseAddressList(email.to), ...parseAddressList(email.cc)]) {
    const lower = addr.toLowerCase();
    if (exclude.has(lower)) continue;
    exclude.add(lower);
    cc.push(addr);
  }
  return { to, cc };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface ReplyInfoSource extends ReplyRecipientSource {
  id: string;
  threadId: string;
  subject: string;
  date: string;
  body?: string;
  attachments?: AttachmentMeta[];
}

/**
 * Build the compose pre-fill for replying to / forwarding `email`.
 *
 * `inReplyTo` / `references` are set to the Gmail message ID as a placeholder;
 * the main process swaps in the real RFC 5322 Message-ID/References headers
 * when it has them.
 */
export function buildReplyInfo(
  email: ReplyInfoSource,
  mode: ComposeMode,
  selfAddresses: readonly string[] = [],
): ReplyInfo {
  const { to, cc } = computeReplyRecipients(email, mode, selfAddresses);

  let subject = email.subject;
  if (mode === "forward") {
    if (!subject.toLowerCase().startsWith("fwd:")) subject = `Fwd: ${subject}`;
  } else if (!subject.toLowerCase().startsWith("re:")) {
    subject = `Re: ${subject}`;
  }

  // Quoted body follows Gmail's markup:
  // - Reply: <div class="gmail_quote"> with the attribution line outside a blockquote
  // - Forward: <div class="gmail_quote"> without blockquote (no visual indentation)
  // See: https://github.com/nylas/nylas-mail/issues/1746
  const dateStr = new Date(email.date).toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const escapedFrom = escapeHtml(email.from);
  const originalBody = email.body ?? "";

  let quotedBody: string;
  let attribution: string;
  if (mode === "forward") {
    let attachmentLine = "";
    if (email.attachments?.length) {
      const names = email.attachments.map((a) => escapeHtml(a.filename)).join(", ");
      attachmentLine = `<br>Attachments: ${names}`;
    }
    attribution = `---------- Forwarded message ---------<br>From: <strong>${escapedFrom}</strong><br>Date: ${dateStr}<br>Subject: ${escapeHtml(email.subject)}<br>To: ${escapeHtml(email.to)}${attachmentLine}`;
    quotedBody = `<br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${attribution}</div><br><br>${originalBody}</div>`;
  } else {
    attribution = `On ${dateStr}, ${escapedFrom} wrote:`;
    quotedBody = `<br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${attribution}</div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${originalBody}</blockquote></div>`;
  }

  return {
    to,
    cc,
    subject,
    threadId: email.threadId,
    inReplyTo: email.id,
    references: email.id,
    quotedBody,
    originalBody,
    attribution,
    ...(mode === "forward" &&
      email.attachments?.length && {
        forwardedAttachments: email.attachments,
      }),
  };
}
