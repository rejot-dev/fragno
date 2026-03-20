import { decodeCursor } from "@fragno-dev/db/cursor";
import type { CreateEmailOptions, Domain, DomainRecords } from "resend";
import { z } from "zod";

import type { ResendFragmentConfig } from "../definition";
import {
  asStringArray,
  getHeader,
  normalizeMessageId,
  normalizeParticipants,
  normalizeSubject,
  parseMessageIdList,
} from "../threading";

export const addressSchema = z.string().min(1);
export const addressListSchema = z.union([addressSchema, z.array(addressSchema).nonempty()]);

export const scheduledInSchema = z
  .object({
    ms: z.coerce.number().int().positive().optional(),
    seconds: z.coerce.number().int().positive().optional(),
    minutes: z.coerce.number().int().positive().optional(),
    hours: z.coerce.number().int().positive().optional(),
    days: z.coerce.number().int().positive().optional(),
  })
  .refine((value) => Object.values(value).some((entry) => typeof entry === "number" && entry > 0), {
    message: "scheduledIn must include a positive interval value.",
  });

export const asTagsArray = (value: unknown) =>
  Array.isArray(value) ? (value as Array<{ name: string; value: string }>) : undefined;

export const asHeadersRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, string>)
    : undefined;

export const toArray = (value?: string | string[]) => {
  if (!value) {
    return undefined;
  }

  return Array.isArray(value) ? value : [value];
};

export const normalizeAddressList = (value?: string | string[]) => {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
};

export const mergeTags = (
  defaults: ResendFragmentConfig["defaultTags"],
  overrides?: ResendFragmentConfig["defaultTags"],
) => {
  const merged = [...(defaults ?? []), ...(overrides ?? [])];
  return merged.length > 0 ? merged : undefined;
};

export const mergeHeaders = (
  defaults: ResendFragmentConfig["defaultHeaders"],
  overrides?: ResendFragmentConfig["defaultHeaders"],
) => {
  const merged = { ...defaults, ...overrides };
  return Object.keys(merged).length > 0 ? merged : undefined;
};

export const resolveEmailPayload = (
  email: {
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string | string[];
    scheduledIn?: unknown;
    from?: string;
    tags?: Array<{ name: string; value: string }>;
    headers?: Record<string, string>;
  } & Omit<CreateEmailOptions, "to" | "cc" | "bcc" | "replyTo" | "tags" | "headers">,
  config: ResendFragmentConfig,
): CreateEmailOptions => {
  const { scheduledIn: _scheduledIn, ...payloadBase } = email;
  return {
    ...payloadBase,
    from: email.from ?? config.defaultFrom,
    replyTo: toArray(email.replyTo ?? config.defaultReplyTo),
    tags: mergeTags(config.defaultTags, email.tags),
    headers: mergeHeaders(config.defaultHeaders, email.headers),
    to: toArray(email.to) ?? [],
    cc: toArray(email.cc),
    bcc: toArray(email.bcc),
  } as CreateEmailOptions;
};

export const resolveThreadEmailPayload = (
  email: {
    from?: string;
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string | string[];
    scheduledIn?: unknown;
    subject?: string | undefined;
    tags?: Array<{ name: string; value: string }>;
    headers?: Record<string, string>;
  },
  config: ResendFragmentConfig,
  subjectFallback?: string | null,
): CreateEmailOptions => {
  const { scheduledIn: _scheduledIn, ...payloadBase } = email;
  return {
    ...payloadBase,
    subject: email.subject ?? subjectFallback ?? undefined,
    from: email.from ?? config.defaultFrom,
    replyTo: toArray(email.replyTo ?? config.defaultReplyTo),
    tags: mergeTags(config.defaultTags, email.tags),
    headers: mergeHeaders(config.defaultHeaders, email.headers),
    to: toArray(email.to) ?? [],
    cc: toArray(email.cc),
    bcc: toArray(email.bcc),
  } as CreateEmailOptions;
};

export const formatErrorMessage = (err: unknown) => {
  if (err instanceof Error) {
    return err.message;
  }

  return String(err);
};

export const safeDecodeCursor = (cursor: string, indexName: string) => {
  try {
    const decoded = decodeCursor(cursor);
    if (decoded.indexName !== indexName) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
};

export const resolveResendId = (email: { providerEmailId: string | null }) =>
  email.providerEmailId ?? null;

export const buildEmailRecord = (
  id: string,
  status: string,
  resendId: string | null,
  createdAt: Date,
  updatedAt: Date,
) => ({
  id,
  status,
  resendId,
  createdAt,
  updatedAt,
});

export const buildEmailPayload = (email: {
  from: string | null;
  to: unknown;
  subject: string | null;
  html: string | null;
  text: string | null;
  cc: unknown;
  bcc: unknown;
  replyTo: unknown;
  tags: unknown;
  headers: unknown;
}) => {
  const toList = asStringArray(email.to);
  const to = toList.length > 0 ? toList : undefined;
  return {
    from: email.from ?? undefined,
    to,
    subject: email.subject ?? undefined,
    html: email.html ?? undefined,
    text: email.text ?? undefined,
    cc: asStringArray(email.cc),
    bcc: asStringArray(email.bcc),
    replyTo: asStringArray(email.replyTo),
    tags: asTagsArray(email.tags),
    headers: asHeadersRecord(email.headers),
  };
};

export const buildEmailSummary = (email: {
  id: { valueOf(): string };
  status: string;
  providerEmailId: string | null;
  from: string | null;
  to: unknown;
  subject: string | null;
  scheduledAt: Date | string | null;
  sentAt: Date | null;
  lastEventType: string | null;
  lastEventAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: email.id.valueOf(),
  status: String(email.status),
  resendId: resolveResendId(email),
  from: email.from ?? null,
  to: normalizeAddressList(asStringArray(email.to)),
  subject: email.subject ?? null,
  scheduledAt:
    email.scheduledAt && !Number.isNaN(new Date(email.scheduledAt).getTime())
      ? new Date(email.scheduledAt).toISOString()
      : null,
  sentAt: email.sentAt ?? null,
  lastEventType: email.lastEventType ?? null,
  lastEventAt: email.lastEventAt ?? null,
  errorCode: email.errorCode ?? null,
  errorMessage: email.errorMessage ?? null,
  createdAt: email.createdAt,
  updatedAt: email.updatedAt,
});

export const buildEmailDetail = (email: {
  id: { valueOf(): string };
  status: string;
  providerEmailId: string | null;
  from: string | null;
  to: unknown;
  subject: string | null;
  html: string | null;
  text: string | null;
  cc: unknown;
  bcc: unknown;
  replyTo: unknown;
  tags: unknown;
  headers: unknown;
  scheduledAt: Date | string | null;
  sentAt: Date | null;
  lastEventType: string | null;
  lastEventAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}) => {
  const scheduledAtDate = email.scheduledAt ? new Date(email.scheduledAt) : null;
  const scheduledAt =
    scheduledAtDate && !Number.isNaN(scheduledAtDate.getTime())
      ? scheduledAtDate.toISOString()
      : null;

  return {
    id: email.id.valueOf(),
    status: String(email.status),
    resendId: resolveResendId(email),
    payload: buildEmailPayload(email),
    scheduledAt,
    sentAt: email.sentAt ?? null,
    lastEventType: email.lastEventType ?? null,
    lastEventAt: email.lastEventAt ?? null,
    errorCode: email.errorCode ?? null,
    errorMessage: email.errorMessage ?? null,
    createdAt: email.createdAt,
    updatedAt: email.updatedAt,
  };
};

export const buildReceivedEmailAttachment = (attachment: {
  id: string;
  filename: string | null;
  size: number;
  content_type: string;
  content_disposition: string | null;
  content_id: string | null;
}) => ({
  id: attachment.id,
  filename: attachment.filename,
  size: attachment.size,
  contentType: attachment.content_type,
  contentDisposition: attachment.content_disposition,
  contentId: attachment.content_id,
});

export const buildReceivedEmailSummary = (email: {
  id: string;
  from: string;
  to: string[];
  cc: string[] | null;
  bcc: string[] | null;
  reply_to: string[] | null;
  subject: string;
  message_id: string;
  attachments: Array<{
    id: string;
    filename: string | null;
    size: number;
    content_type: string;
    content_id: string | null;
    content_disposition: string | null;
  }>;
  created_at: string;
}) => {
  const attachments = email.attachments.map((attachment) =>
    buildReceivedEmailAttachment(attachment),
  );
  return {
    id: email.id,
    from: email.from,
    to: email.to,
    cc: email.cc ?? [],
    bcc: email.bcc ?? [],
    replyTo: email.reply_to ?? [],
    subject: email.subject,
    messageId: email.message_id,
    attachments,
    attachmentCount: attachments.length,
    createdAt: email.created_at,
  };
};

export const buildReceivedEmailDetail = (email: {
  id: string;
  from: string;
  to: string[];
  cc: string[] | null;
  bcc: string[] | null;
  reply_to: string[] | null;
  subject: string;
  message_id: string;
  attachments: Array<{
    id: string;
    filename: string | null;
    size: number;
    content_type: string;
    content_id: string | null;
    content_disposition: string | null;
  }>;
  created_at: string;
  html: string | null;
  text: string | null;
  headers: Record<string, string> | null;
  raw?: {
    download_url: string;
    expires_at: string;
  } | null;
}) => {
  const attachments = email.attachments.map((attachment) =>
    buildReceivedEmailAttachment(attachment),
  );
  return {
    id: email.id,
    from: email.from,
    to: email.to,
    cc: email.cc ?? [],
    bcc: email.bcc ?? [],
    replyTo: email.reply_to ?? [],
    subject: email.subject,
    messageId: email.message_id,
    attachments,
    attachmentCount: attachments.length,
    createdAt: email.created_at,
    html: email.html,
    text: email.text,
    headers: email.headers,
    raw: email.raw
      ? {
          downloadUrl: email.raw.download_url,
          expiresAt: email.raw.expires_at,
        }
      : null,
  };
};

export const buildThreadSummary = (thread: {
  id: { valueOf(): string };
  subject: string | null;
  normalizedSubject: string;
  participants: unknown;
  messageCount: number;
  firstMessageAt: Date;
  lastMessageAt: Date;
  lastDirection: string | null;
  lastMessagePreview: string | null;
}): {
  id: string;
  subject: string | null;
  normalizedSubject: string;
  participants: string[];
  messageCount: number;
  firstMessageAt: Date;
  lastMessageAt: Date;
  lastDirection: string | null;
  lastMessagePreview: string | null;
  createdAt: Date;
  updatedAt: Date;
} => ({
  id: thread.id.valueOf(),
  subject: thread.subject ?? null,
  normalizedSubject: thread.normalizedSubject,
  participants: asStringArray(thread.participants),
  messageCount: Number(thread.messageCount ?? 0),
  firstMessageAt: thread.firstMessageAt,
  lastMessageAt: thread.lastMessageAt,
  lastDirection: thread.lastDirection ?? null,
  lastMessagePreview: thread.lastMessagePreview ?? null,
  createdAt: thread.firstMessageAt,
  updatedAt: thread.lastMessageAt,
});

export const buildThreadDetail = (
  thread: {
    id: { valueOf(): string };
    subject: string | null;
    normalizedSubject: string;
    participants: unknown;
    messageCount: number;
    firstMessageAt: Date;
    lastMessageAt: Date;
    lastDirection: string | null;
    lastMessagePreview: string | null;
    replyToken: string;
  },
  config: ResendFragmentConfig,
  buildReplyAddress: (replyToken: string, config: ResendFragmentConfig) => string | null,
) => ({
  ...buildThreadSummary(thread),
  replyToAddress: buildReplyAddress(thread.replyToken, config),
});

export const buildThreadMessage = (message: {
  id: { valueOf(): string };
  threadId: { valueOf(): unknown } | string;
  direction: string;
  status: string;
  providerEmailId: string | null;
  from: string | null;
  to: unknown;
  cc: unknown;
  bcc: unknown;
  replyTo: unknown;
  subject: string | null;
  messageId: string | null;
  attachments: unknown;
  html: string | null;
  text: string | null;
  headers: unknown;
  occurredAt: Date;
  scheduledAt: Date | null;
  sentAt: Date | null;
  lastEventType: string | null;
  lastEventAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}) => {
  const direction: "inbound" | "outbound" =
    message.direction === "inbound" ? "inbound" : "outbound";
  const to = asStringArray(message.to);
  const cc = asStringArray(message.cc);
  const bcc = asStringArray(message.bcc);
  const replyTo = asStringArray(message.replyTo);
  const headers = asHeadersRecord(message.headers) ?? null;
  const normalizedSubject = normalizeSubject(message.subject);
  const participants = normalizeParticipants([message.from, ...to, ...cc, ...bcc]);
  const inReplyTo = parseMessageIdList(getHeader(headers, "In-Reply-To"))[0] ?? null;
  const references = parseMessageIdList(getHeader(headers, "References"));
  const messageId =
    message.messageId ?? parseMessageIdList(getHeader(headers, "Message-ID"))[0] ?? null;
  const threadId =
    typeof message.threadId === "string" ? message.threadId : String(message.threadId.valueOf());

  return {
    id: message.id.valueOf(),
    threadId,
    direction,
    status: message.status,
    from: message.from ?? null,
    to,
    cc,
    bcc,
    replyTo,
    subject: message.subject ?? null,
    normalizedSubject,
    participants,
    messageId: normalizeMessageId(messageId),
    inReplyTo,
    references,
    providerEmailId: message.providerEmailId ?? null,
    attachments: Array.isArray(message.attachments)
      ? (message.attachments as Array<{
          id: string;
          filename: string | null;
          size: number;
          contentType: string;
          contentDisposition: string | null;
          contentId: string | null;
        }>)
      : [],
    html: message.html ?? null,
    text: message.text ?? null,
    headers,
    occurredAt: message.occurredAt,
    scheduledAt: message.scheduledAt ?? null,
    sentAt: message.sentAt ?? null,
    lastEventType: message.lastEventType ?? null,
    lastEventAt: message.lastEventAt ?? null,
    errorCode: message.errorCode ?? null,
    errorMessage: message.errorMessage ?? null,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
};

export const buildDomainSummary = (domain: Domain) => ({
  id: domain.id,
  name: domain.name,
  status: domain.status,
  createdAt: domain.created_at,
  region: domain.region,
  capabilities: {
    sending: domain.capabilities.sending,
    receiving: domain.capabilities.receiving,
  },
});

export const buildDomainRecord = (record: DomainRecords) => ({
  record: record.record,
  name: record.name,
  value: record.value,
  type: record.type,
  ttl: record.ttl,
  status: record.status,
  routingPolicy: "routing_policy" in record ? record.routing_policy : undefined,
  priority: "priority" in record ? record.priority : undefined,
  proxyStatus: "proxy_status" in record ? record.proxy_status : undefined,
});

export const buildDomainDetail = (domain: Domain & { records: DomainRecords[] }) => ({
  ...buildDomainSummary(domain),
  records: domain.records.map((record) => buildDomainRecord(record)),
});

export type AddressSchema = typeof addressSchema;
