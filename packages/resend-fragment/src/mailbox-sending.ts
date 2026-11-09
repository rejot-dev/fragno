import { getHeader, normalizeMessageId, parseMessageIdList } from "./threading";

/**
 * The most a mailbox email's attachments may hold together, in bytes. The stored message keeps
 * their content until Resend accepts the email, and a row holds at most 2 MB.
 */
export const MAX_MAILBOX_ATTACHMENT_BYTES = 1_000_000;

/** A file to send from a mailbox. */
export interface ResendMailboxAttachmentInput {
  filename: string;
  /** The file's bytes, base64-encoded. */
  content: string;
  /** Resend infers it from the filename when omitted. */
  contentType?: string;
}

/** An attachment as a sent message stores it: its content stays only until Resend accepts it. */
export type StoredMailboxAttachment = {
  id: string;
  filename: string;
  size: number;
  contentType: string | null;
  contentDisposition: "attachment";
  contentId: null;
  content?: string;
};

const domainOf = (mailbox: string) => mailbox.slice(mailbox.lastIndexOf("@") + 1);

/**
 * The address an address header sends to, lowercased: the one in its trailing angle brackets, as
 * in `Shop <orders@shop.example>`. A display name may hold another address, which is not it.
 */
export function headerMailbox(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  const mailbox = (/<([^<>]+)>$/u.exec(trimmed)?.[1] ?? trimmed).trim().toLowerCase();
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/u.test(mailbox) ? mailbox : null;
}

const base64ByteLength = (content: string) =>
  Math.floor((content.replace(/=+$/u, "").length * 3) / 4);

/** The mailbox's address as From, under `name` when there is one. */
export function formatMailboxFrom(address: string, name: string | null): string {
  if (!name) {
    return address;
  }
  // Quoted, the name cannot break out of the header. Quotes, backslashes and line breaks are dropped,
  // and angle brackets, so the name cannot pose as another address.
  return `"${name.replace(/["\\\r\n<>]/gu, "")}" <${address}>`;
}

/**
 * Who a reply to a received email goes to: its From address, the one the authentication checks
 * vouch for. Reply-To is ignored: it can name anyone, even on the From domain, such as another
 * account at a shared mail provider.
 */
export function replyRecipients(email: { from: string | null }): string[] {
  const from = headerMailbox(email.from);
  return from === null ? [] : [from];
}

/** The received email's subject as a reply's, once prefixed with Re:. */
export function replySubject(subject: string | null): string {
  const original = subject?.trim() ?? "";
  return /^re\s*:/iu.test(original) ? original : `Re: ${original}`.trim();
}

/** In-Reply-To and References, so mail clients show the reply in the received email's conversation. */
export function replyThreadingHeaders(email: {
  messageId: string | null;
  headers: Record<string, string> | null;
}): Record<string, string> {
  const messageId =
    normalizeMessageId(email.messageId) ??
    parseMessageIdList(getHeader(email.headers, "Message-ID"))[0] ??
    null;
  if (messageId === null) {
    return {};
  }
  const references = new Set([
    ...parseMessageIdList(getHeader(email.headers, "References")),
    messageId,
  ]);
  return { "In-Reply-To": messageId, References: [...references].join(" ") };
}

/** A Message-ID on the mailbox's domain, so replies to it find the message it identifies. */
export function buildMailboxMessageId(address: string): string {
  return `<${crypto.randomUUID()}@${domainOf(address)}>`;
}

export function prepareMailboxAttachments(
  attachments: readonly ResendMailboxAttachmentInput[],
): StoredMailboxAttachment[] {
  const prepared = attachments.map(
    ({ filename, content, contentType }): StoredMailboxAttachment => ({
      id: crypto.randomUUID(),
      filename,
      size: base64ByteLength(content),
      contentType: contentType ?? null,
      contentDisposition: "attachment",
      contentId: null,
      content,
    }),
  );
  const total = prepared.reduce((sum, { size }) => sum + size, 0);
  if (total > MAX_MAILBOX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachments hold ${total} bytes together; a mailbox email may attach at most ${MAX_MAILBOX_ATTACHMENT_BYTES}.`,
    );
  }
  return prepared;
}

/** Stored attachments that still hold the content Resend needs, in its send payload's shape. */
export function readPendingAttachments(stored: unknown) {
  return (Array.isArray(stored) ? (stored as Partial<StoredMailboxAttachment>[]) : []).flatMap(
    ({ filename, content, contentType }) =>
      typeof content === "string"
        ? [{ filename, content, ...(contentType ? { contentType } : {}) }]
        : [],
  );
}

/** Stored attachments without their content, once Resend has it. */
export function withoutAttachmentContent(stored: unknown): unknown {
  return Array.isArray(stored)
    ? (stored as Partial<StoredMailboxAttachment>[]).map(({ content: _content, ...metadata }) => ({
        ...metadata,
      }))
    : stored;
}
