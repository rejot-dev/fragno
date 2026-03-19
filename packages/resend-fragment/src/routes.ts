import { decodeCursor } from "@fragno-dev/db/cursor";
import type { CreateEmailOptions, Domain, DomainRecords } from "resend";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { resendFragmentDefinition, type ResendFragmentConfig } from "./definition";
import { resendSchema } from "./schema";

const addressSchema = z.string().min(1);
const addressListSchema = z.union([addressSchema, z.array(addressSchema).nonempty()]);

const scheduledInSchema = z
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

const resendEmailSchemaBase = z.object({
  from: z.string().min(1).optional(),
  to: addressListSchema,
  subject: z.string().min(1),
  html: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  cc: addressListSchema.optional(),
  bcc: addressListSchema.optional(),
  replyTo: addressListSchema.optional(),
  tags: z
    .array(
      z.object({
        name: z.string().min(1),
        value: z.string().min(1),
      }),
    )
    .optional(),
  headers: z.record(z.string(), z.string()).optional(),
  scheduledIn: scheduledInSchema.optional(),
});

export const resendEmailSchema = resendEmailSchemaBase.superRefine((value, ctx) => {
  if (!value.html && !value.text) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Either html or text is required.",
      path: ["html"],
    });
  }
});

export const resendSendEmailInputSchema = resendEmailSchema;
const resendEmailPayloadSchema = resendEmailSchemaBase
  .omit({ scheduledIn: true })
  .partial()
  .passthrough();

export const resendEmailRecordSchema = z.object({
  id: z.string(),
  status: z.string(),
  resendId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const resendSendEmailOutputSchema = resendEmailRecordSchema;
export const resendEmailSummarySchema = z.object({
  id: z.string(),
  status: z.string(),
  resendId: z.string().nullable(),
  from: z.string().nullable(),
  to: z.array(z.string()),
  subject: z.string().nullable(),
  scheduledAt: z.string().nullable(),
  sentAt: z.date().nullable(),
  lastEventType: z.string().nullable(),
  lastEventAt: z.date().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const resendEmailDetailSchema = z.object({
  id: z.string(),
  status: z.string(),
  resendId: z.string().nullable(),
  payload: resendEmailPayloadSchema,
  scheduledAt: z.string().nullable(),
  sentAt: z.date().nullable(),
  lastEventType: z.string().nullable(),
  lastEventAt: z.date().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const resendListEmailsOutputSchema = z.object({
  emails: z.array(resendEmailSummarySchema),
  cursor: z.string().optional(),
  hasNextPage: z.boolean(),
});

export const resendReceivedEmailAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string().nullable(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  contentDisposition: z.string().nullable(),
  contentId: z.string().nullable(),
});

const resendReceivedEmailRawSchema = z.object({
  downloadUrl: z.string(),
  expiresAt: z.string(),
});

export const resendReceivedEmailSummarySchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  replyTo: z.array(z.string()),
  subject: z.string(),
  messageId: z.string(),
  attachments: z.array(resendReceivedEmailAttachmentSchema),
  attachmentCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});

export const resendReceivedEmailDetailSchema = resendReceivedEmailSummarySchema.extend({
  html: z.string().nullable(),
  text: z.string().nullable(),
  headers: z.record(z.string(), z.string()).nullable(),
  raw: resendReceivedEmailRawSchema.nullable(),
});

export const resendListReceivedEmailsOutputSchema = z.object({
  emails: z.array(resendReceivedEmailSummarySchema),
  cursor: z.string().optional(),
  hasNextPage: z.boolean(),
});

const resendDomainCapabilityStatusSchema = z.enum(["enabled", "disabled"]);
const resendDomainStatusSchema = z.enum([
  "pending",
  "verified",
  "failed",
  "temporary_failure",
  "not_started",
]);
const resendDomainRegionSchema = z.enum(["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"]);

export const resendDomainSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: resendDomainStatusSchema,
  createdAt: z.string(),
  region: resendDomainRegionSchema,
  capabilities: z.object({
    sending: resendDomainCapabilityStatusSchema,
    receiving: resendDomainCapabilityStatusSchema,
  }),
});

const resendDomainRecordSchema = z.object({
  record: z.enum(["SPF", "DKIM", "Receiving"]),
  name: z.string(),
  value: z.string(),
  type: z.enum(["MX", "TXT", "CNAME"]),
  ttl: z.string(),
  status: resendDomainStatusSchema,
  routingPolicy: z.string().optional(),
  priority: z.number().optional(),
  proxyStatus: z.enum(["enable", "disable"]).optional(),
});

export const resendListDomainsOutputSchema = z.object({
  domains: z.array(resendDomainSchema),
  hasMore: z.boolean(),
});

export const resendDomainDetailSchema = resendDomainSchema.extend({
  records: z.array(resendDomainRecordSchema),
});

export type ResendEmailInput = z.infer<typeof resendEmailSchema>;
export type ResendSendEmailInput = z.infer<typeof resendSendEmailInputSchema>;
export type ResendEmailRecord = z.infer<typeof resendEmailRecordSchema>;
export type ResendEmailSummary = z.infer<typeof resendEmailSummarySchema>;
export type ResendEmailDetail = z.infer<typeof resendEmailDetailSchema>;
export type ResendListEmailsOutput = z.infer<typeof resendListEmailsOutputSchema>;
export type ResendReceivedEmailAttachment = z.infer<typeof resendReceivedEmailAttachmentSchema>;
export type ResendReceivedEmailSummary = z.infer<typeof resendReceivedEmailSummarySchema>;
export type ResendReceivedEmailDetail = z.infer<typeof resendReceivedEmailDetailSchema>;
export type ResendListReceivedEmailsOutput = z.infer<typeof resendListReceivedEmailsOutputSchema>;
export type ResendDomain = z.infer<typeof resendDomainSchema>;
export type ResendDomainRecord = z.infer<typeof resendDomainRecordSchema>;
export type ResendDomainDetail = z.infer<typeof resendDomainDetailSchema>;
export type ResendListDomainsOutput = z.infer<typeof resendListDomainsOutputSchema>;

const toArray = (value?: string | string[]) => {
  if (!value) {
    return undefined;
  }

  return Array.isArray(value) ? value : [value];
};

const mergeTags = (
  defaults: ResendFragmentConfig["defaultTags"],
  overrides?: ResendEmailInput["tags"],
) => {
  const merged = [...(defaults ?? []), ...(overrides ?? [])];
  return merged.length > 0 ? merged : undefined;
};

const mergeHeaders = (
  defaults: ResendFragmentConfig["defaultHeaders"],
  overrides?: ResendEmailInput["headers"],
) => {
  const merged = { ...defaults, ...overrides };
  return Object.keys(merged).length > 0 ? merged : undefined;
};

const normalizeAddressList = (value?: string | string[]) => {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
};

const resolveEmailPayload = (
  email: ResendEmailInput,
  config: ResendFragmentConfig,
): CreateEmailOptions => {
  // zod validates html/text presence, but TS can't infer the constraint.
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

const formatErrorMessage = (err: unknown) => {
  if (err instanceof Error) {
    return err.message;
  }

  return String(err);
};

const buildEmailRecord = (
  id: string,
  status: string,
  resendId: string | null,
  createdAt: Date,
  updatedAt: Date,
): ResendEmailRecord => ({
  id,
  status,
  resendId,
  createdAt,
  updatedAt,
});

const resendListEmailsQuerySchema = z.object({
  cursor: z.string().optional(),
  pageSize: z.coerce.number().min(1).max(100).catch(50),
  order: z.enum(["asc", "desc"]).catch("desc"),
  status: z.string().min(1).optional(),
});

const resendListReceivedEmailsQuerySchema = z.object({
  cursor: z.string().optional(),
  pageSize: z.coerce.number().min(1).max(100).catch(50),
  order: z.enum(["asc", "desc"]).catch("desc"),
});

const safeDecodeCursor = (cursor: string, indexName: string) => {
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

const resolveResendId = (email: { id: { valueOf(): string }; sentAt: Date | null }) =>
  email.sentAt ? email.id.valueOf() : null;

const asStringArray = (value: unknown) => (Array.isArray(value) ? (value as string[]) : undefined);

const asTagsArray = (value: unknown) =>
  Array.isArray(value) ? (value as Array<{ name: string; value: string }>) : undefined;

const asHeadersRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, string>)
    : undefined;

const buildEmailPayload = (email: {
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
  const to = toList && toList.length > 0 ? toList : undefined;
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

const buildEmailSummary = (email: {
  id: { valueOf(): string };
  status: string;
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
}): ResendEmailSummary => {
  const scheduledAtDate = email.scheduledAt ? new Date(email.scheduledAt) : null;
  const scheduledAt =
    scheduledAtDate && !Number.isNaN(scheduledAtDate.getTime())
      ? scheduledAtDate.toISOString()
      : null;
  const toList = asStringArray(email.to);
  return {
    id: email.id.valueOf(),
    status: String(email.status),
    resendId: resolveResendId(email),
    from: email.from ?? null,
    to: normalizeAddressList(toList),
    subject: email.subject ?? null,
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

const buildEmailDetail = (email: {
  id: { valueOf(): string };
  status: string;
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
}): ResendEmailDetail => {
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

const buildReceivedEmailAttachment = (attachment: {
  id: string;
  filename: string | null;
  size: number;
  content_type: string;
  content_disposition: string | null;
  content_id: string | null;
}): ResendReceivedEmailAttachment => ({
  id: attachment.id,
  filename: attachment.filename,
  size: attachment.size,
  contentType: attachment.content_type,
  contentDisposition: attachment.content_disposition,
  contentId: attachment.content_id,
});

const buildReceivedEmailSummary = (email: {
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
}): ResendReceivedEmailSummary => {
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

const buildReceivedEmailDetail = (email: {
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
}): ResendReceivedEmailDetail => {
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

const buildDomainSummary = (domain: Domain): ResendDomain => ({
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

const buildDomainRecord = (record: DomainRecords): ResendDomainRecord => ({
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

const buildDomainDetail = (domain: Domain & { records: DomainRecords[] }): ResendDomainDetail => ({
  ...buildDomainSummary(domain),
  records: domain.records.map((record) => buildDomainRecord(record)),
});

export const resendRoutesFactory = defineRoutes(resendFragmentDefinition).create(
  ({ defineRoute, config, deps }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/domains",
        outputSchema: resendListDomainsOutputSchema,
        errorCodes: ["RESEND_API_ERROR"] as const,
        handler: async function (_input, { json, error }) {
          try {
            const response = await deps.resend.domains.list({ limit: 100 });

            if (response.error) {
              return error(
                {
                  message: response.error.message,
                  code: "RESEND_API_ERROR",
                },
                502,
              );
            }

            if (!response.data) {
              return error(
                {
                  message: "Resend returned no domain data.",
                  code: "RESEND_API_ERROR",
                },
                502,
              );
            }

            return json({
              domains: response.data.data.map((domain) => buildDomainSummary(domain)),
              hasMore: response.data.has_more,
            });
          } catch (err) {
            return error(
              {
                message: formatErrorMessage(err),
                code: "RESEND_API_ERROR",
              },
              502,
            );
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/domains/:domainId",
        outputSchema: resendDomainDetailSchema,
        errorCodes: ["DOMAIN_NOT_FOUND", "RESEND_API_ERROR"] as const,
        handler: async function ({ pathParams }, { json, error }) {
          try {
            const response = await deps.resend.domains.get(pathParams.domainId);

            if (response.error) {
              if (response.error.name === "not_found") {
                return error(
                  {
                    message: "Domain not found.",
                    code: "DOMAIN_NOT_FOUND",
                  },
                  404,
                );
              }

              return error(
                {
                  message: response.error.message,
                  code: "RESEND_API_ERROR",
                },
                502,
              );
            }

            if (!response.data) {
              return error(
                {
                  message: "Resend returned no domain detail.",
                  code: "RESEND_API_ERROR",
                },
                502,
              );
            }

            return json(buildDomainDetail(response.data));
          } catch (err) {
            return error(
              {
                message: formatErrorMessage(err),
                code: "RESEND_API_ERROR",
              },
              502,
            );
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/received-emails",
        queryParameters: ["cursor", "pageSize", "order"],
        outputSchema: resendListReceivedEmailsOutputSchema,
        errorCodes: ["RESEND_API_ERROR"] as const,
        handler: async function ({ query }, { json, error }) {
          const parsed = resendListReceivedEmailsQuerySchema.parse({
            cursor: query.get("cursor") ?? undefined,
            pageSize: query.get("pageSize"),
            order: query.get("order"),
          });

          try {
            const response = await deps.resend.emails.receiving.list({
              limit: parsed.pageSize,
              ...(parsed.cursor
                ? parsed.order === "asc"
                  ? { before: parsed.cursor }
                  : { after: parsed.cursor }
                : {}),
            });

            if (response.error) {
              return error(
                {
                  message: response.error.message,
                  code: "RESEND_API_ERROR",
                },
                502,
              );
            }

            if (!response.data) {
              return error(
                {
                  message: "Resend returned no received email data.",
                  code: "RESEND_API_ERROR",
                },
                502,
              );
            }

            const emails = response.data.data.map((email) => buildReceivedEmailSummary(email));
            return json({
              emails,
              cursor:
                response.data.has_more && emails.length > 0
                  ? emails[emails.length - 1]?.id
                  : undefined,
              hasNextPage: response.data.has_more,
            });
          } catch (err) {
            return error(
              {
                message: formatErrorMessage(err),
                code: "RESEND_API_ERROR",
              },
              502,
            );
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/received-emails/:emailId",
        outputSchema: resendReceivedEmailDetailSchema,
        errorCodes: ["RECEIVED_EMAIL_NOT_FOUND", "RESEND_API_ERROR"] as const,
        handler: async function ({ pathParams }, { json, error }) {
          try {
            const response = await deps.resend.emails.receiving.get(pathParams.emailId);

            if (response.error) {
              if (response.error.name === "not_found") {
                return error(
                  {
                    message: "Received email not found.",
                    code: "RECEIVED_EMAIL_NOT_FOUND",
                  },
                  404,
                );
              }

              return error(
                {
                  message: response.error.message,
                  code: "RESEND_API_ERROR",
                },
                502,
              );
            }

            if (!response.data) {
              return error(
                {
                  message: "Resend returned no received email detail.",
                  code: "RESEND_API_ERROR",
                },
                502,
              );
            }

            return json(buildReceivedEmailDetail(response.data));
          } catch (err) {
            return error(
              {
                message: formatErrorMessage(err),
                code: "RESEND_API_ERROR",
              },
              502,
            );
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/emails",
        queryParameters: ["cursor", "pageSize", "order", "status"],
        outputSchema: resendListEmailsOutputSchema,
        handler: async function ({ query }, { json }) {
          const parsed = resendListEmailsQuerySchema.parse({
            cursor: query.get("cursor") ?? undefined,
            pageSize: query.get("pageSize"),
            order: query.get("order"),
            status: query.get("status") ?? undefined,
          });

          const status = parsed.status?.trim();
          const indexName = status ? "idx_email_status_createdAt" : "idx_email_createdAt";
          const cursor = parsed.cursor ? safeDecodeCursor(parsed.cursor, indexName) : undefined;

          const result = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(resendSchema).findWithCursor("email", (b) => {
                if (status) {
                  const base = b.whereIndex("idx_email_status_createdAt", (eb) =>
                    eb("status", "=", status),
                  );
                  const ordered = base
                    .orderByIndex("idx_email_status_createdAt", parsed.order)
                    .pageSize(parsed.pageSize);
                  return cursor ? ordered.after(cursor) : ordered;
                }

                const base = b.whereIndex("idx_email_createdAt");
                const ordered = base
                  .orderByIndex("idx_email_createdAt", parsed.order)
                  .pageSize(parsed.pageSize);
                return cursor ? ordered.after(cursor) : ordered;
              }),
            )
            .mutate(({ retrieveResult: [page] }) => {
              return {
                emails: page.items.map((email) => buildEmailSummary(email)),
                cursor: page.cursor?.encode(),
                hasNextPage: page.hasNextPage,
              };
            })
            .execute();

          return json(result);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/emails/:emailId",
        outputSchema: resendEmailDetailSchema,
        errorCodes: ["EMAIL_NOT_FOUND"] as const,
        handler: async function ({ pathParams }, { json, error }) {
          const email = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(resendSchema).findFirst("email", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", pathParams.emailId)),
              ),
            )
            .transformRetrieve(([record]) => record ?? null)
            .execute();

          if (!email) {
            return error(
              {
                message: "Email not found.",
                code: "EMAIL_NOT_FOUND",
              },
              404,
            );
          }

          return json(buildEmailDetail(email));
        },
      }),
      defineRoute({
        method: "POST",
        path: "/emails",
        inputSchema: resendSendEmailInputSchema,
        outputSchema: resendSendEmailOutputSchema,
        errorCodes: ["MISSING_FROM"] as const,
        handler: async function ({ input }, { json, error }) {
          const rawEmail = await input.valid();
          const payload = resolveEmailPayload(rawEmail, config);

          if (!payload.from) {
            return error(
              {
                message: "Missing from address. Provide it in the request or config.defaultFrom.",
                code: "MISSING_FROM",
              },
              400,
            );
          }

          const now = new Date();

          const record = await this.handlerTx()
            .mutate(({ forSchema }) => {
              const uow = forSchema(resendSchema);
              const scheduledAtValue = rawEmail.scheduledIn
                ? uow.now().plus(rawEmail.scheduledIn)
                : null;
              const status = scheduledAtValue ? "scheduled" : "queued";
              const to = toArray(payload.to) ?? [];
              const cc = toArray(payload.cc);
              const bcc = toArray(payload.bcc);
              const replyTo = toArray(payload.replyTo);
              const emailId = uow.create("email", {
                status,
                from: payload.from ?? null,
                to,
                cc: cc ?? null,
                bcc: bcc ?? null,
                replyTo: replyTo ?? null,
                subject: payload.subject ?? null,
                html: payload.html ?? null,
                text: payload.text ?? null,
                tags: payload.tags ?? null,
                headers: payload.headers ?? null,
                scheduledAt: scheduledAtValue ?? null,
                sentAt: null,
                lastEventType: null,
                lastEventAt: null,
                errorCode: null,
                errorMessage: null,
              });

              uow.triggerHook(
                "sendEmail",
                { emailId: emailId.valueOf() },
                scheduledAtValue ? { processAt: scheduledAtValue } : undefined,
              );

              return buildEmailRecord(emailId.valueOf(), status, null, now, now);
            })
            .execute();

          return json(record);
        },
      }),
      defineRoute({
        method: "POST",
        path: "/resend/webhook",
        outputSchema: z.object({
          success: z.boolean(),
        }),
        errorCodes: ["MISSING_SIGNATURE", "WEBHOOK_SIGNATURE_INVALID", "WEBHOOK_ERROR"] as const,
        handler: async function ({ headers, rawBody }, { json, error }) {
          if (!config.webhookSecret) {
            return error(
              {
                message: "Missing webhook secret in config",
                code: "WEBHOOK_ERROR",
              },
              400,
            );
          }

          const id = headers.get("svix-id");
          const timestamp = headers.get("svix-timestamp");
          const signature = headers.get("svix-signature");

          if (!id || !timestamp || !signature) {
            return error(
              {
                message: "Missing webhook signature headers",
                code: "MISSING_SIGNATURE",
              },
              400,
            );
          }

          if (!rawBody) {
            return error(
              {
                message: "Missing request body for webhook verification",
                code: "WEBHOOK_ERROR",
              },
              400,
            );
          }

          let event;
          try {
            event = deps.resend.webhooks.verify({
              payload: rawBody,
              headers: {
                id,
                timestamp,
                signature,
              },
              webhookSecret: config.webhookSecret,
            });
          } catch (err) {
            return error(
              {
                message: formatErrorMessage(err),
                code: "WEBHOOK_SIGNATURE_INVALID",
              },
              400,
            );
          }

          await this.handlerTx()
            .mutate(({ forSchema }) => {
              const uow = forSchema(resendSchema);
              uow.triggerHook("onResendWebhook", { event });
            })
            .execute();

          return json({ success: true });
        },
      }),
    ];
  },
);
