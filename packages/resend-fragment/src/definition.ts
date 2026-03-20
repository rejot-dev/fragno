import type { SelectResult } from "@fragno-dev/db/query";
import { Resend } from "resend";
import type { CreateEmailOptions, ErrorResponse, WebhookEventPayload } from "resend";

import { defineFragment } from "@fragno-dev/core";
import {
  serviceCalls,
  withDatabase,
  type DatabaseServiceContext,
  type HookFn,
  type TypedUnitOfWork,
} from "@fragno-dev/db";

import { resendSchema } from "./schema";
import {
  buildHeuristicKey,
  buildInboundThreadEnvelope,
  buildParticipantKey,
  generateOpaqueToken,
  mergeParticipants,
  withinRecencyWindow,
  type ReceivedEmailDetailLike,
} from "./threading";

export interface ResendReceivedEmailAttachment {
  id: string;
  filename: string | null;
  contentType: string;
  contentDisposition: string | null;
  contentId: string | null;
}

export interface ResendEmailStatusUpdatedHookPayload {
  emailMessageId: string;
  providerEmailId: string;
  status: string;
  eventType: string;
  event: WebhookEventPayload;
  idempotencyKey: string;
}

export interface ResendEmailReceivedHookPayload {
  emailMessageId: string;
  providerEmailId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  messageId: string;
  attachments: ResendReceivedEmailAttachment[];
  receivedAt: string;
  webhookReceivedAt: string;
  threadId: string;
  threadResolvedVia: "reply-token" | "in-reply-to" | "references" | "heuristic" | "new-thread";
  eventType: "email.received";
  event: WebhookEventPayload;
  idempotencyKey: string;
}

export interface ResendFragmentConfig {
  apiKey: string;
  webhookSecret: string;
  defaultFrom?: string;
  defaultReplyTo?: string | string[];
  threadReplyBaseAddress?: string;
  defaultTags?: Array<{ name: string; value: string }>;
  defaultHeaders?: Record<string, string>;
  onEmailStatusUpdated?: (payload: ResendEmailStatusUpdatedHookPayload) => Promise<void> | void;
  onEmailReceived?: (payload: ResendEmailReceivedHookPayload) => Promise<void> | void;
}

type ResendEmailWebhookEvent = Extract<WebhookEventPayload, { type: `email.${string}` }>;
type ResendReceivedEmailWebhookEvent = Extract<WebhookEventPayload, { type: "email.received" }>;
type DeliverEmailReceivedHookPayload = {
  event: ResendReceivedEmailWebhookEvent;
  emailMessageId: string;
  threadId: string;
  threadResolvedVia: ResendEmailReceivedHookPayload["threadResolvedVia"];
};
type DeliverEmailStatusUpdatedHookPayload = {
  event: ResendEmailWebhookEvent;
  emailMessageId: string;
};

export type ResendHooksMap = {
  sendEmail: HookFn<{ emailId: string }>;
  onResendWebhook: HookFn<{ event: WebhookEventPayload }>;
  deliverEmailReceived: HookFn<DeliverEmailReceivedHookPayload>;
  deliverEmailStatusUpdated: HookFn<DeliverEmailStatusUpdatedHookPayload>;
};

type ResendUow = TypedUnitOfWork<typeof resendSchema>;
type ResendEmailMessageRow = SelectResult<
  (typeof resendSchema)["tables"]["emailMessage"],
  {},
  true
>;
type ResendThreadRow = SelectResult<(typeof resendSchema)["tables"]["emailThread"], {}, true>;
type ResendServiceContext = DatabaseServiceContext<ResendHooksMap>;

const isEmailWebhookEvent = (event: WebhookEventPayload): event is ResendEmailWebhookEvent =>
  event.type.startsWith("email.");

const isReceivedEmailWebhookEvent = (
  event: WebhookEventPayload,
): event is ResendReceivedEmailWebhookEvent => event.type === "email.received";

const statusFromWebhookEvent = (event: ResendEmailWebhookEvent) => {
  return event.type.replace("email.", "");
};

const buildReceivedEmailDeliveryHookId = (emailMessageId: string) => {
  return `deliver-email-received:${emailMessageId}`;
};

const buildStatusUpdatedDeliveryHookId = (
  emailMessageId: string,
  eventType: ResendEmailWebhookEvent["type"],
) => {
  return `deliver-email-status-updated:${emailMessageId}:${eventType}`;
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

const buildReceivedEmailAttachments = (
  attachments: ResendReceivedEmailWebhookEvent["data"]["attachments"],
): ResendReceivedEmailAttachment[] => {
  return attachments.map((attachment) => ({
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.content_type,
    contentDisposition: attachment.content_disposition,
    contentId: attachment.content_id,
  }));
};

const buildResendPayload = (email: ResendEmailMessageRow): CreateEmailOptions => {
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

const sortThreadsByRecent = (threads: ResendThreadRow[]) => {
  return [...threads].sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
};

const appendToThreadSummary = (
  uow: ResendUow,
  existingThread: ResendThreadRow | null,
  input: {
    threadId?: string;
    subject: string | null;
    normalizedSubject: string;
    participants: string[];
    occurredAt: Date;
    direction: "inbound" | "outbound";
    preview: string | null;
    replyToken?: string;
  },
) => {
  const nextParticipants = mergeParticipants(existingThread?.participants, input.participants);
  const participantKey = buildParticipantKey(nextParticipants);
  const normalizedSubject = existingThread?.normalizedSubject ?? input.normalizedSubject;
  const heuristicKey = buildHeuristicKey(normalizedSubject, participantKey);

  if (existingThread) {
    const shouldUpdateLastMessage =
      input.occurredAt.getTime() >= existingThread.lastMessageAt.getTime();

    uow.update("emailThread", existingThread.id, (b) =>
      b
        .set({
          subject: existingThread.subject ?? input.subject,
          normalizedSubject,
          participants: nextParticipants,
          heuristicKey,
          messageCount: Number(existingThread.messageCount ?? 0) + 1,
          lastMessageAt: shouldUpdateLastMessage ? input.occurredAt : existingThread.lastMessageAt,
          lastDirection: shouldUpdateLastMessage ? input.direction : existingThread.lastDirection,
          lastMessagePreview: shouldUpdateLastMessage
            ? input.preview
            : existingThread.lastMessagePreview,
        })
        .check(),
    );

    return {
      threadId: existingThread.id,
      participants: nextParticipants,
      normalizedSubject,
      heuristicKey,
    };
  }

  const threadId = uow.create("emailThread", {
    id: input.threadId,
    subject: input.subject,
    normalizedSubject,
    participants: nextParticipants,
    heuristicKey,
    replyToken: input.replyToken ?? generateOpaqueToken(),
    messageCount: 1,
    firstMessageAt: input.occurredAt,
    lastMessageAt: input.occurredAt,
    lastDirection: input.direction,
    lastMessagePreview: input.preview,
  });

  return {
    threadId,
    participants: nextParticipants,
    normalizedSubject,
    heuristicKey,
  };
};

const resolveInboundThread = ({
  replyTokenThread,
  inReplyToThread,
  referencesThread,
  heuristicThread,
}: {
  replyTokenThread: ResendThreadRow | null | undefined;
  inReplyToThread: ResendThreadRow | null | undefined;
  referencesThread: ResendThreadRow | null | undefined;
  heuristicThread: ResendThreadRow | null | undefined;
}): {
  thread: ResendThreadRow | null;
  threadResolvedVia: ResendEmailReceivedHookPayload["threadResolvedVia"];
} => {
  if (replyTokenThread) {
    return { thread: replyTokenThread, threadResolvedVia: "reply-token" };
  }

  if (inReplyToThread) {
    return { thread: inReplyToThread, threadResolvedVia: "in-reply-to" };
  }

  if (referencesThread) {
    return { thread: referencesThread, threadResolvedVia: "references" };
  }

  if (heuristicThread) {
    return { thread: heuristicThread, threadResolvedVia: "heuristic" };
  }

  return { thread: null, threadResolvedVia: "new-thread" };
};

const defineResendServiceMethods = <T>(methods: T & ThisType<ResendServiceContext>) => methods;

const createResendServiceMethods = () => {
  const services = defineResendServiceMethods({
    getThreadById: function (threadId: string) {
      return this.serviceTx(resendSchema)
        .retrieve((uow) =>
          uow.findFirst("emailThread", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", threadId)),
          ),
        )
        .transformRetrieve(([thread]) => thread ?? null)
        .build();
    },

    findThreadByReplyToken: function (replyToken: string) {
      return this.serviceTx(resendSchema)
        .retrieve((uow) =>
          uow.findFirst("emailThread", (b) =>
            b.whereIndex("idx_emailThread_replyToken", (eb) => eb("replyToken", "=", replyToken)),
          ),
        )
        .transformRetrieve(([thread]) => thread ?? null)
        .build();
    },

    findThreadByMessageId: function (messageId: string) {
      return this.serviceTx(resendSchema)
        .retrieve((uow) =>
          uow.findFirst("emailMessage", (b) =>
            b
              .whereIndex("idx_emailMessage_messageId", (eb) => eb("messageId", "=", messageId))
              .join((j) => j.emailMessageThread()),
          ),
        )
        .transformRetrieve(([message]) => message?.emailMessageThread ?? null)
        .build();
    },

    findFirstThreadByMessageIds: function (messageIds: string[]) {
      return this.serviceTx(resendSchema)
        .withServiceCalls(() =>
          messageIds.map((messageId) => services.findThreadByMessageId.call(this, messageId)),
        )
        .transformRetrieve(
          (_, serviceResult) => serviceResult.find((thread) => thread !== null) ?? null,
        )
        .build();
    },

    findRecentHeuristicThread: function (heuristicKey: string, receivedAt: Date) {
      return this.serviceTx(resendSchema)
        .retrieve((uow) =>
          uow.find("emailThread", (b) =>
            b.whereIndex("idx_emailThread_heuristicKey", (eb) =>
              eb("heuristicKey", "=", heuristicKey),
            ),
          ),
        )
        .transformRetrieve(([threads]) => {
          return (
            sortThreadsByRecent(threads).find((thread) =>
              withinRecencyWindow(thread.lastMessageAt, receivedAt),
            ) ?? null
          );
        })
        .build();
    },
  });

  return services;
};

const createResendServices = (defineService: <T>(svc: T & ThisType<ResendServiceContext>) => T) => {
  return defineService(createResendServiceMethods());
};

export const resendFragmentDefinition = defineFragment<ResendFragmentConfig>("resend")
  .extend(withDatabase(resendSchema))
  .withDependencies(({ config }) => ({
    resend: new Resend(config.apiKey),
  }))
  .providesBaseService(({ defineService }) => createResendServices(defineService))
  .provideHooks<ResendHooksMap>(({ defineHook, deps, config, services }) => ({
    sendEmail: defineHook(async function (payload) {
      const prepared = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(resendSchema).findFirst("emailMessage", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", payload.emailId)),
          ),
        )
        .mutate(({ forSchema, retrieveResult: [email] }) => {
          if (!email) {
            return { action: "missing" as const };
          }

          if (email.direction !== "outbound") {
            return { action: "skip" as const };
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
          uow.update("emailMessage", email.id, (b) =>
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
              id: email.id.valueOf(),
              payload: buildResendPayload(email),
            },
          };
        })
        .execute();

      if (prepared.action !== "send") {
        return;
      }

      const resendIdempotencyKey = this.idempotencyKey;

      const updateEmail = async (
        handler: (uow: ResendUow, email: ResendEmailMessageRow) => void,
      ) => {
        await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(resendSchema).findFirst("emailMessage", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", prepared.email.id)),
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
          uow.update("emailMessage", email.id, (b) =>
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
          uow.update("emailMessage", email.id, (b) =>
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
          uow.update("emailMessage", email.id, (b) =>
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
        uow.update("emailMessage", email.id, (b) =>
          b
            .set({
              providerEmailId: response.data.id,
              status: "sent",
              sentAt: now,
              updatedAt: now,
              lastEventType: "email.sent",
              lastEventAt: now,
              errorCode: null,
              errorMessage: null,
            })
            .check(),
        );
      });
    }),
    deliverEmailReceived: defineHook(async function ({
      event,
      emailMessageId,
      threadId,
      threadResolvedVia,
    }) {
      if (!config.onEmailReceived) {
        return;
      }

      await config.onEmailReceived({
        emailMessageId,
        providerEmailId: event.data.email_id,
        from: event.data.from,
        to: event.data.to,
        cc: event.data.cc,
        bcc: event.data.bcc,
        subject: event.data.subject,
        messageId: event.data.message_id,
        attachments: buildReceivedEmailAttachments(event.data.attachments),
        receivedAt: event.data.created_at,
        webhookReceivedAt: event.created_at,
        threadId,
        threadResolvedVia,
        eventType: event.type,
        event,
        idempotencyKey: this.idempotencyKey,
      });
    }),
    deliverEmailStatusUpdated: defineHook(async function ({ event, emailMessageId }) {
      if (!config.onEmailStatusUpdated) {
        return;
      }

      await config.onEmailStatusUpdated({
        emailMessageId,
        providerEmailId: event.data.email_id,
        status: statusFromWebhookEvent(event),
        eventType: event.type,
        event,
        idempotencyKey: this.idempotencyKey,
      });
    }),
    onResendWebhook: defineHook(async function ({ event }) {
      if (isReceivedEmailWebhookEvent(event)) {
        const receivedAt = new Date(event.data.created_at);
        const webhookReceivedAt = new Date(event.created_at);

        const receivedResponse = await deps.resend.emails.receiving.get(event.data.email_id);
        if (receivedResponse.error) {
          throw new Error(receivedResponse.error.message);
        }
        if (!receivedResponse.data) {
          throw new Error("Resend returned no received email detail.");
        }

        const receivedDetail = receivedResponse.data as ReceivedEmailDetailLike;
        const inbound = buildInboundThreadEnvelope(receivedDetail);

        await this.handlerTx()
          .withServiceCalls(() =>
            serviceCalls(
              inbound.replyToken ? services.findThreadByReplyToken(inbound.replyToken) : undefined,
              inbound.inReplyTo ? services.findThreadByMessageId(inbound.inReplyTo) : undefined,
              inbound.references.length > 0
                ? services.findFirstThreadByMessageIds(inbound.references)
                : undefined,
              inbound.heuristicKey
                ? services.findRecentHeuristicThread(inbound.heuristicKey, receivedAt)
                : undefined,
            ),
          )
          .retrieve(({ forSchema }) =>
            forSchema(resendSchema).findFirst("emailMessage", (b) =>
              b.whereIndex("idx_emailMessage_providerEmailId", (eb) =>
                eb("providerEmailId", "=", event.data.email_id),
              ),
            ),
          )
          .transformRetrieve(
            (
              [existingMessage],
              [replyTokenThread, inReplyToThread, referencesThread, heuristicThread],
            ) => ({
              existingMessage,
              replyTokenThread: replyTokenThread ?? null,
              inReplyToThread: inReplyToThread ?? null,
              referencesThread: referencesThread ?? null,
              heuristicThread: heuristicThread ?? null,
            }),
          )
          .mutate(({ forSchema, retrieveResult }) => {
            const {
              existingMessage,
              replyTokenThread,
              inReplyToThread,
              referencesThread,
              heuristicThread,
            } = retrieveResult;

            if (existingMessage) {
              return;
            }

            const { thread: resolvedThread, threadResolvedVia } = resolveInboundThread({
              replyTokenThread,
              inReplyToThread,
              referencesThread,
              heuristicThread,
            });

            const uow = forSchema(resendSchema);
            const threadSummary = appendToThreadSummary(uow, resolvedThread, {
              subject: receivedDetail.subject,
              normalizedSubject: inbound.normalizedSubject,
              participants: inbound.participants,
              occurredAt: receivedAt,
              direction: "inbound",
              preview: inbound.preview,
            });

            const emailMessageId = uow.create("emailMessage", {
              threadId: threadSummary.threadId,
              direction: "inbound",
              status: "received",
              providerEmailId: receivedDetail.id,
              from: receivedDetail.from,
              to: receivedDetail.to,
              cc: receivedDetail.cc ?? null,
              bcc: receivedDetail.bcc ?? null,
              replyTo: receivedDetail.reply_to ?? null,
              subject: receivedDetail.subject,
              messageId: inbound.messageId,
              headers: receivedDetail.headers,
              html: receivedDetail.html,
              text: receivedDetail.text,
              attachments: inbound.attachments,
              tags: null,
              occurredAt: receivedAt,
              scheduledAt: null,
              sentAt: null,
              lastEventType: event.type,
              lastEventAt: webhookReceivedAt,
              errorCode: null,
              errorMessage: null,
            });

            if (!config.onEmailReceived) {
              return;
            }

            const emailMessageIdValue = emailMessageId.valueOf();
            uow.triggerHook(
              "deliverEmailReceived",
              {
                event,
                emailMessageId: emailMessageIdValue,
                threadId: String(threadSummary.threadId),
                threadResolvedVia,
              },
              { id: buildReceivedEmailDeliveryHookId(emailMessageIdValue) },
            );
          })
          .execute();
        return;
      }

      if (!isEmailWebhookEvent(event)) {
        return;
      }

      const providerEmailId = event.data.email_id;
      const status = statusFromWebhookEvent(event);
      const eventAt = new Date(event.created_at);

      await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(resendSchema).findFirst("emailMessage", (b) =>
            b.whereIndex("idx_emailMessage_providerEmailId", (eb) =>
              eb("providerEmailId", "=", providerEmailId),
            ),
          ),
        )
        .mutate(({ forSchema, retrieveResult: [email] }) => {
          if (!email) {
            return;
          }

          if (email.lastEventAt && eventAt.getTime() <= email.lastEventAt.getTime()) {
            return;
          }

          const uow = forSchema(resendSchema);
          const emailMessageId = email.id.valueOf();
          uow.update("emailMessage", email.id, (b) =>
            b
              .set({
                status,
                lastEventType: event.type,
                lastEventAt: eventAt,
                updatedAt: uow.now(),
              })
              .check(),
          );

          if (!config.onEmailStatusUpdated) {
            return;
          }

          uow.triggerHook(
            "deliverEmailStatusUpdated",
            {
              event,
              emailMessageId,
            },
            { id: buildStatusUpdatedDeliveryHookId(emailMessageId, event.type) },
          );
        })
        .execute();
    }),
  }))
  .build();
