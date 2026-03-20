type AddressConfig = {
  threadReplyBaseAddress?: string;
  defaultFrom?: string;
  defaultReplyTo?: string | string[];
};

export interface ThreadAttachment {
  id: string;
  filename: string | null;
  size: number;
  contentType: string;
  contentDisposition: string | null;
  contentId: string | null;
}

export interface ReceivedEmailDetailLike {
  id: string;
  from: string;
  to: string[];
  cc: string[] | null;
  bcc: string[] | null;
  reply_to: string[] | null;
  subject: string;
  message_id: string;
  created_at: string;
  html: string | null;
  text: string | null;
  headers: Record<string, string> | null;
  attachments: Array<{
    id: string;
    filename: string | null;
    size: number;
    content_type: string;
    content_disposition: string | null;
    content_id: string | null;
  }>;
}

const mailboxPattern = /<?([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i;

const splitCommaSeparated = (value: string) => {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const dedupe = (values: string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

const dedupeCaseInsensitive = (values: string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
};

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

export const asAddressList = (value?: string | string[] | null) => {
  if (!value) {
    return [] as string[];
  }

  if (Array.isArray(value)) {
    return value.map((entry) => entry.trim()).filter(Boolean);
  }

  return splitCommaSeparated(value);
};

export const extractMailbox = (value?: string | null) => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  const angleMatch = trimmed.match(/<([^>]+)>/);
  const candidate = angleMatch?.[1]?.trim() ?? trimmed;
  const match = candidate.match(mailboxPattern);
  return match?.[1]?.toLowerCase() ?? null;
};

export const normalizeParticipants = (values: Array<string | null | undefined>) => {
  const participants = values
    .flatMap((value) => asAddressList(value ?? undefined))
    .map((value) => extractMailbox(value))
    .filter((value): value is string => Boolean(value));

  return dedupe(participants).sort();
};

export const buildParticipantKey = (participants: string[]) => participants.join("|");

export const normalizeSubject = (subject?: string | null) => {
  let current = normalizeWhitespace(subject ?? "");

  while (/^(re|fw|fwd)\s*:/i.test(current)) {
    current = normalizeWhitespace(current.replace(/^(re|fw|fwd)\s*:\s*/i, ""));
  }

  return current.toLowerCase();
};

export const buildHeuristicKey = (normalizedSubjectValue: string, participantKey: string) => {
  return `${normalizedSubjectValue}::${participantKey}`;
};

export const normalizeMessageId = (value?: string | null) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed;
  }
  return `<${trimmed.replace(/^<+|>+$/g, "")}>`;
};

export const parseMessageIdList = (value?: string | null) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return [] as string[];
  }

  const bracketed = [...trimmed.matchAll(/<[^>]+>/g)].map((match) => normalizeMessageId(match[0]));
  const normalizedBracketed = bracketed.filter((entry): entry is string => Boolean(entry));
  if (normalizedBracketed.length > 0) {
    return dedupe(normalizedBracketed);
  }

  return dedupe(
    trimmed
      .split(/[\s,]+/)
      .map((entry) => normalizeMessageId(entry))
      .filter((entry): entry is string => Boolean(entry)),
  );
};

export const getHeader = (headers: Record<string, string> | null | undefined, name: string) => {
  if (!headers) {
    return undefined;
  }

  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }

  return undefined;
};

export const buildPreviewText = (text?: string | null, html?: string | null) => {
  const source = text ?? html?.replace(/<[^>]+>/g, " ") ?? "";
  const normalized = normalizeWhitespace(source);
  return normalized ? normalized.slice(0, 280) : null;
};

export const resolveThreadReplyBaseAddress = (config: AddressConfig) => {
  const candidates = [
    config.threadReplyBaseAddress,
    ...asAddressList(config.defaultReplyTo),
    config.defaultFrom,
  ];

  for (const candidate of candidates) {
    const mailbox = extractMailbox(candidate);
    if (mailbox) {
      return mailbox;
    }
  }

  return null;
};

export const generateOpaqueToken = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const buildThreadReplyAddress = (replyToken: string, config: AddressConfig) => {
  const baseAddress = resolveThreadReplyBaseAddress(config);
  if (!baseAddress) {
    return null;
  }

  const [rawLocalPart, domain] = baseAddress.split("@");
  if (!rawLocalPart || !domain) {
    return null;
  }

  const localPart = rawLocalPart.split("+")[0] ?? rawLocalPart;
  return `${localPart}+${replyToken}@${domain}`.toLowerCase();
};

export const buildThreadReplyToList = (
  replyToken: string,
  config: AddressConfig,
  extraReplyTo: string[],
) => {
  const threadReplyAddress = buildThreadReplyAddress(replyToken, config);
  const merged = dedupeCaseInsensitive([
    ...(threadReplyAddress ? [threadReplyAddress] : []),
    ...extraReplyTo,
  ]);

  return merged.length > 0 ? merged : undefined;
};

export const extractReplyTokenFromAddress = (value?: string | null) => {
  const mailbox = extractMailbox(value);
  if (!mailbox) {
    return null;
  }

  const [localPart] = mailbox.split("@");
  if (!localPart) {
    return null;
  }

  const plusIndex = localPart.lastIndexOf("+");
  if (plusIndex < 0 || plusIndex === localPart.length - 1) {
    return null;
  }

  return localPart.slice(plusIndex + 1);
};

export const extractReplyTokenFromAddresses = (values: Array<string | null | undefined>) => {
  for (const value of values) {
    for (const entry of asAddressList(value ?? undefined)) {
      const token = extractReplyTokenFromAddress(entry);
      if (token) {
        return token;
      }
    }
  }

  return null;
};

export const buildThreadMessageId = (threadId: string, config: AddressConfig) => {
  const baseAddress =
    resolveThreadReplyBaseAddress(config) ?? extractMailbox(config.defaultFrom) ?? "fragno.local";
  const [, domain = "fragno.local"] = baseAddress.split("@");
  return `<thread.${threadId}.${generateOpaqueToken()}@${domain}>`;
};

export const buildThreadAttachments = (attachments: ReceivedEmailDetailLike["attachments"]) => {
  return attachments.map((attachment) => ({
    id: attachment.id,
    filename: attachment.filename,
    size: attachment.size,
    contentType: attachment.content_type,
    contentDisposition: attachment.content_disposition,
    contentId: attachment.content_id,
  })) satisfies ThreadAttachment[];
};

export const buildInboundThreadEnvelope = (detail: ReceivedEmailDetailLike) => {
  const inReplyTo = parseMessageIdList(getHeader(detail.headers, "In-Reply-To"))[0] ?? null;
  const references = parseMessageIdList(getHeader(detail.headers, "References"));
  const messageId =
    normalizeMessageId(detail.message_id) ??
    parseMessageIdList(getHeader(detail.headers, "Message-ID"))[0] ??
    null;
  const participants = normalizeParticipants([
    detail.from,
    ...detail.to,
    ...(detail.cc ?? []),
    ...(detail.bcc ?? []),
  ]);
  const normalizedSubjectValue = normalizeSubject(detail.subject);
  const participantKey = buildParticipantKey(participants);

  return {
    inReplyTo,
    references,
    messageId,
    participants,
    participantKey,
    normalizedSubject: normalizedSubjectValue,
    heuristicKey: buildHeuristicKey(normalizedSubjectValue, participantKey),
    replyToken: extractReplyTokenFromAddresses([
      ...detail.to,
      ...(detail.cc ?? []),
      ...(detail.bcc ?? []),
      ...(detail.reply_to ?? []),
    ]),
    attachments: buildThreadAttachments(detail.attachments),
    preview: buildPreviewText(detail.text, detail.html),
  };
};

export const mergeParticipants = (existing: unknown, next: string[]) => {
  const current = Array.isArray(existing)
    ? existing.filter((entry): entry is string => typeof entry === "string")
    : [];
  return dedupe([...current, ...next]).sort();
};

export const asStringArray = (value: unknown) => {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};

export const withinRecencyWindow = (
  candidate: Date,
  occurredAt: Date,
  windowMs = 1000 * 60 * 60 * 24 * 14,
) => {
  return Math.abs(occurredAt.getTime() - candidate.getTime()) <= windowMs;
};
