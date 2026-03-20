import { z } from "zod";

import type { ResendRouteFactoryContext } from "./context";
import { formatErrorMessage } from "./shared";
import { buildReceivedEmailDetail, buildReceivedEmailSummary } from "./shared";

export const resendReceivedEmailAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string().nullable(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  contentDisposition: z.string().nullable(),
  contentId: z.string().nullable(),
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
  raw: z
    .object({
      downloadUrl: z.string(),
      expiresAt: z.string(),
    })
    .nullable(),
});

export const resendListReceivedEmailsOutputSchema = z.object({
  emails: z.array(resendReceivedEmailSummarySchema),
  cursor: z.string().optional(),
  hasNextPage: z.boolean(),
});

export type ResendReceivedEmailAttachment = z.infer<typeof resendReceivedEmailAttachmentSchema>;
export type ResendReceivedEmailSummary = z.infer<typeof resendReceivedEmailSummarySchema>;
export type ResendReceivedEmailDetail = z.infer<typeof resendReceivedEmailDetailSchema>;
export type ResendListReceivedEmailsOutput = z.infer<typeof resendListReceivedEmailsOutputSchema>;

const resendListReceivedEmailsQuerySchema = z.object({
  cursor: z.string().optional(),
  pageSize: z.coerce.number().min(1).max(100).catch(50),
  order: z.enum(["asc", "desc"]).catch("desc"),
});

export const registerReceivedEmailRoutes = ({ defineRoute, deps }: ResendRouteFactoryContext) => [
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
            response.data.has_more && emails.length > 0 ? emails[emails.length - 1]?.id : undefined,
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
];
