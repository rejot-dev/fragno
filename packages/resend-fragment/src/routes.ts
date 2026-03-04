import { defineRoutes } from "@fragno-dev/core";
import { decodeCursor } from "@fragno-dev/db/cursor";
import { z } from "zod";
import type { CreateEmailOptions } from "resend";
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

export type ResendEmailInput = z.infer<typeof resendEmailSchema>;
export type ResendSendEmailInput = z.infer<typeof resendSendEmailInputSchema>;
export type ResendEmailRecord = z.infer<typeof resendEmailRecordSchema>;
export type ResendEmailSummary = z.infer<typeof resendEmailSummarySchema>;
export type ResendEmailDetail = z.infer<typeof resendEmailDetailSchema>;
export type ResendListEmailsOutput = z.infer<typeof resendListEmailsOutputSchema>;

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

export const resendRoutesFactory = defineRoutes(resendFragmentDefinition).create(
  ({ defineRoute, config, deps }) => {
    return [
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
              { message: "Missing webhook secret in config", code: "WEBHOOK_ERROR" },
              400,
            );
          }

          const id = headers.get("svix-id");
          const timestamp = headers.get("svix-timestamp");
          const signature = headers.get("svix-signature");

          if (!id || !timestamp || !signature) {
            return error(
              { message: "Missing webhook signature headers", code: "MISSING_SIGNATURE" },
              400,
            );
          }

          if (!rawBody) {
            return error(
              { message: "Missing request body for webhook verification", code: "WEBHOOK_ERROR" },
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
