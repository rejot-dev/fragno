import { z } from "zod";

import { resendSchema } from "../schema";
import type { ResendRouteFactoryContext } from "./context";
import {
  addressListSchema,
  resolveEmailPayload,
  scheduledInSchema,
  safeDecodeCursor,
  toArray,
  buildEmailRecord,
  buildEmailSummary,
  buildEmailDetail,
} from "./shared";

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

const applyBodyValidation = (value: { html?: string; text?: string }, ctx: z.RefinementCtx) => {
  if (!value.html && !value.text) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Either html or text is required.",
      path: ["html"],
    });
  }
};

export const resendEmailSchema = resendEmailSchemaBase.superRefine(applyBodyValidation);
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

export const resendSendEmailOutputSchema = resendEmailRecordSchema;
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

const resendListEmailsQuerySchema = z.object({
  cursor: z.string().optional(),
  pageSize: z.coerce.number().min(1).max(100).catch(50),
  order: z.enum(["asc", "desc"]).catch("desc"),
  status: z.string().min(1).optional(),
});

export const registerEmailRoutes = ({ defineRoute, config }: ResendRouteFactoryContext) => [
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
      const indexName = status
        ? "idx_emailMessage_direction_status_occurredAt"
        : "idx_emailMessage_direction_occurredAt";
      const cursor = parsed.cursor ? safeDecodeCursor(parsed.cursor, indexName) : undefined;

      const result = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(resendSchema).findWithCursor("emailMessage", (b) => {
            if (status) {
              const base = b.whereIndex("idx_emailMessage_direction_status_occurredAt", (eb) =>
                eb.and(eb("direction", "=", "outbound"), eb("status", "=", status)),
              );
              const ordered = base
                .orderByIndex("idx_emailMessage_direction_status_occurredAt", parsed.order)
                .pageSize(parsed.pageSize);
              return cursor ? ordered.after(cursor) : ordered;
            }

            const base = b.whereIndex("idx_emailMessage_direction_occurredAt", (eb) =>
              eb("direction", "=", "outbound"),
            );
            const ordered = base
              .orderByIndex("idx_emailMessage_direction_occurredAt", parsed.order)
              .pageSize(parsed.pageSize);
            return cursor ? ordered.after(cursor) : ordered;
          }),
        )
        .mutate(({ retrieveResult: [page] }) => ({
          emails: page.items.map((email) => buildEmailSummary(email)),
          cursor: page.cursor?.encode(),
          hasNextPage: page.hasNextPage,
        }))
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
          forSchema(resendSchema).findFirst("emailMessage", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", pathParams.emailId)),
          ),
        )
        .transformRetrieve(([record]) =>
          record && record.direction === "outbound" ? record : null,
        )
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
          const emailId = uow.create("emailMessage", {
            direction: "outbound",
            threadId: null,
            status,
            providerEmailId: null,
            from: payload.from ?? null,
            to,
            cc: cc ?? null,
            bcc: bcc ?? null,
            replyTo: replyTo ?? null,
            subject: payload.subject ?? null,
            messageId: null,
            headers: payload.headers ?? null,
            html: payload.html ?? null,
            text: payload.text ?? null,
            attachments: null,
            tags: payload.tags ?? null,
            occurredAt: uow.now(),
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
];
