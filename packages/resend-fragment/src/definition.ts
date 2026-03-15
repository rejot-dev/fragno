import type { SelectResult, TableToUpdateValues } from "@fragno-dev/db/query";
import { Resend } from "resend";
import type { CreateEmailOptions, ErrorResponse, WebhookEventPayload } from "resend";

import { defineFragment } from "@fragno-dev/core";
import { withDatabase, type HookFn, type TypedUnitOfWork } from "@fragno-dev/db";

import { resendSchema } from "./schema";

export interface ResendFragmentConfig {
  apiKey: string;
  webhookSecret: string;
  defaultFrom?: string;
  defaultReplyTo?: string | string[];
  defaultTags?: Array<{ name: string; value: string }>;
  defaultHeaders?: Record<string, string>;
  onEmailStatusUpdated?: (payload: {
    emailId: string;
    resendId: string;
    status: string;
    eventType: string;
    event: WebhookEventPayload;
    idempotencyKey: string;
  }) => Promise<void> | void;
}

type ResendEmailWebhookEvent = Extract<WebhookEventPayload, { type: `email.${string}` }>;

export type ResendHooksMap = {
  sendEmail: HookFn<{ emailId: string }>;
  onResendWebhook: HookFn<{ event: WebhookEventPayload }>;
};

type ResendUow = TypedUnitOfWork<typeof resendSchema>;
type ResendEmailRow = SelectResult<(typeof resendSchema)["tables"]["email"], {}, true>;

const isEmailWebhookEvent = (event: WebhookEventPayload): event is ResendEmailWebhookEvent =>
  event.type.startsWith("email.");

const statusFromWebhookEvent = (event: ResendEmailWebhookEvent) => {
  return event.type.replace("email.", "");
};

const formatResendError = (error: unknown) => {
  if (!error) {
    return { message: "Unknown error", code: "unknown" };
  }

  if (typeof error === "object" && "message" in error) {
    const message = String(error.message ?? "Unknown error");
    const code =
      typeof error === "object" && error && "name" in error
        ? String(error.name ?? "unknown")
        : "unknown";
    return { message, code };
  }

  if (typeof error === "string") {
    return { message: error, code: "unknown" };
  }

  return { message: String(error), code: "unknown" };
};

const formatResendApiError = (error: ErrorResponse) => {
  return { message: error.message, code: error.name };
};

const normalizeAddressList = (value?: string[] | null) => {
  if (!value || value.length === 0) {
    return undefined;
  }
  return value;
};

const buildResendPayload = (email: ResendEmailRow): CreateEmailOptions => {
  const renderOptions = email.html
    ? { html: email.html, text: email.text ?? undefined }
    : { text: email.text ?? "" };

  return {
    from: email.from ?? "",
    to: (email.to as string[]) ?? [],
    subject: email.subject ?? "",
    ...renderOptions,
    cc: normalizeAddressList(email.cc as string[] | null),
    bcc: normalizeAddressList(email.bcc as string[] | null),
    replyTo: normalizeAddressList(email.replyTo as string[] | null),
    tags: (email.tags as CreateEmailOptions["tags"]) ?? undefined,
    headers: (email.headers as CreateEmailOptions["headers"]) ?? undefined,
  };
};

export const resendFragmentDefinition = defineFragment<ResendFragmentConfig>("resend")
  .extend(withDatabase(resendSchema))
  .withDependencies(({ config }) => ({
    resend: new Resend(config.apiKey),
  }))
  .provideHooks<ResendHooksMap>(({ defineHook, deps, config }) => ({
    sendEmail: defineHook(async function (payload) {
      const prepared = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(resendSchema).findFirst("email", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", payload.emailId)),
          ),
        )
        .mutate(({ forSchema, retrieveResult: [email] }) => {
          if (!email) {
            return { action: "missing" as const };
          }

          const status = String(email.status);
          if (
            status !== "queued" &&
            status !== "scheduled" &&
            status !== "sending" &&
            status !== "failed"
          ) {
            return { action: "skip" as const };
          }

          const uow = forSchema(resendSchema);
          uow.update("email", email.id, (b) =>
            b
              .set({
                status: "sending",
                updatedAt: uow.now(),
                errorCode: null,
                errorMessage: null,
              })
              .check(),
          );

          return {
            action: "send" as const,
            email: {
              id: email.id,
              idValue: email.id.valueOf(),
              payload: buildResendPayload(email),
            },
          };
        })
        .execute();

      if (prepared.action !== "send") {
        return;
      }

      const resendIdempotencyKey = this.idempotencyKey;

      const updateEmail = async (handler: (uow: ResendUow, email: ResendEmailRow) => void) => {
        await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(resendSchema).findFirst("email", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", prepared.email.idValue)),
            ),
          )
          .mutate(({ forSchema, retrieveResult: [email] }) => {
            if (!email) {
              return;
            }

            const uow = forSchema(resendSchema);
            handler(uow, email);
          })
          .execute();
      };

      let response;
      try {
        response = await deps.resend.emails.send(prepared.email.payload, {
          idempotencyKey: resendIdempotencyKey,
        });
      } catch (error) {
        const formatted = formatResendError(error);
        await updateEmail((uow, email) => {
          uow.update("email", email.id, (b) =>
            b
              .set({
                status: "failed",
                updatedAt: uow.now(),
                errorCode: formatted.code,
                errorMessage: formatted.message,
              })
              .check(),
          );
        });
        return;
      }

      if (response.error) {
        const formatted = formatResendApiError(response.error);
        await updateEmail((uow, email) => {
          uow.update("email", email.id, (b) =>
            b
              .set({
                status: "failed",
                updatedAt: uow.now(),
                errorCode: formatted.code,
                errorMessage: formatted.message,
              })
              .check(),
          );
        });
        return;
      }

      if (!response.data) {
        await updateEmail((uow, email) => {
          uow.update("email", email.id, (b) =>
            b
              .set({
                status: "failed",
                updatedAt: uow.now(),
                errorCode: "missing_response",
                errorMessage: "Resend returned no data",
              })
              .check(),
          );
        });
        return;
      }

      await updateEmail((uow, email) => {
        const now = uow.now();
        uow.update("email", email.id, (b) =>
          b
            .set({
              // Align external ID with Resend's email ID after a successful send.
              id: response.data.id,
              status: "sent",
              sentAt: now,
              updatedAt: now,
              errorCode: null,
              errorMessage: null,
            } as unknown as TableToUpdateValues<typeof resendSchema.tables.email>)
            .check(),
        );
      });
    }),
    onResendWebhook: defineHook(async function ({ event }) {
      if (!isEmailWebhookEvent(event)) {
        return;
      }

      const resendId = event.data.email_id;
      const status = statusFromWebhookEvent(event);
      const eventAt = new Date(event.created_at);

      const result = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(resendSchema).findFirst("email", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", resendId)),
          ),
        )
        .mutate(({ forSchema, retrieveResult: [email] }) => {
          if (!email) {
            return { updated: false as const };
          }

          if (email.lastEventAt && eventAt.getTime() <= email.lastEventAt.getTime()) {
            return { updated: false as const };
          }

          const uow = forSchema(resendSchema);
          uow.update("email", email.id, (b) =>
            b
              .set({
                status,
                lastEventType: event.type,
                lastEventAt: eventAt,
                updatedAt: uow.now(),
              })
              .check(),
          );

          return {
            updated: true as const,
            emailId: email.id.valueOf(),
            status,
          };
        })
        .execute();

      if (!result.updated || !config.onEmailStatusUpdated) {
        return;
      }

      await config.onEmailStatusUpdated({
        emailId: result.emailId,
        resendId,
        status: result.status,
        eventType: event.type,
        event,
        idempotencyKey: this.idempotencyKey,
      });
    }),
  }))
  .build();
