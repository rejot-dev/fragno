import type { SelectResult } from "@fragno-dev/db/query";
import { Resend } from "resend";
import type { CreateEmailOptions, ErrorResponse, WebhookEventPayload } from "resend";

import { defineFragment } from "@fragno-dev/core";
import {
  serviceCalls,
  withDatabase,
  type DatabaseServiceContext,
  type HookContext,
  type HookFn,
  type TypedUnitOfWork,
} from "@fragno-dev/db";

import { readEmailAuthentication, type ResendEmailAuthentication } from "./email-authentication";
import { normalizeMailboxAddress, parseMailboxAddress } from "./mailbox-address";
import type { ResendSendEmailInput } from "./routes/emails";
import { buildThreadMessage, resolveEmailPayload, toArray } from "./routes/shared";
import type { ResendThreadMessage } from "./routes/threads";
import { resendSchema } from "./schema";
import {
  buildHeuristicKey,
  buildInboundThreadEnvelope,
  buildParticipantKey,
  extractMailbox,
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

/** A registered address and the owner it delivers to, which the fragment never interprets. */
export interface ResendMailboxMatch {
  address: string;
  owner: string;
}

/** An owner's one address. A paused mailbox keeps its address but is not in use. */
export type ResendMailbox = {
  owner: string;
  address: string;
  paused: boolean;
};

export type ResendOpenMailboxResult =
  | { status: "opened"; mailbox: ResendMailbox }
  /** Issued before, to this owner or another; an address is never issued twice. */
  | { status: "taken" }
  | { status: "invalid"; message: string };

export type ResendReplaceMailboxAddressResult =
  | { status: "replaced"; mailbox: ResendMailbox }
  | { status: "taken" }
  | { status: "invalid"; message: string }
  | { status: "not-found" };

export type ResendPauseMailboxResult = { status: "paused" } | { status: "not-found" };

/** A received message with the recipient mailbox that makes its owner its reader. */
export type ResendMailboxEmail = ResendThreadMessage & {
  recipientMailbox: ResendMailboxMatch;
};

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
  /**
   * The registered address the email was delivered to: the callback runs once for each owner it
   * reached, or once with null when it reached none.
   */
  recipientMailbox: ResendMailboxMatch | null;
  /** Resend's SPF, DKIM and DMARC results; null when Resend reported none. */
  authentication: ResendEmailAuthentication | null;
  receivedAt: string;
  webhookReceivedAt: string;
  threadId: string;
  threadResolvedVia: "reply-token" | "in-reply-to" | "references" | "heuristic" | "new-thread";
  eventType: "email.received";
  event: WebhookEventPayload;
  /** One per delivery: it differs between the owners an email reached, and stays across retries. */
  idempotencyKey: string;
}

export interface ResendFragmentConfig {
  apiKey: string;
  /** The Resend client the fragment calls, such as a fake in tests; built from apiKey if omitted. */
  client?: Resend;
  webhookSecret: string;
  defaultFrom?: string;
  defaultReplyTo?: string | string[];
  threadReplyBaseAddress?: string;
  defaultTags?: Array<{ name: string; value: string }>;
  defaultHeaders?: Record<string, string>;
  onEmailStatusUpdated?: (payload: ResendEmailStatusUpdatedHookPayload) => Promise<void> | void;
  onEmailReceived?: (payload: ResendEmailReceivedHookPayload) => Promise<void> | void;
  /**
   * A mailbox opened, resumed, paused, or moved to a new address. It is delivered durably after the
   * change commits, and retried until it succeeds.
   */
  onMailboxChanged?: (mailbox: ResendMailbox, context: HookContext) => Promise<void> | void;
}

type ResendEmailWebhookEvent = Extract<WebhookEventPayload, { type: `email.${string}` }>;
type ResendReceivedEmailWebhookEvent = Extract<WebhookEventPayload, { type: "email.received" }>;
type DeliverEmailReceivedHookPayload = {
  event: ResendReceivedEmailWebhookEvent;
  emailMessageId: string;
  threadId: string;
  threadResolvedVia: ResendEmailReceivedHookPayload["threadResolvedVia"];
  recipientMailbox: ResendMailboxMatch | null;
  /** Absent from deliveries queued before the fragment stored it. */
  authentication?: ResendEmailAuthentication | null;
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
  deliverMailboxChanged: HookFn<ResendMailbox>;
};

type ResendUow = TypedUnitOfWork<typeof resendSchema>;
type ResendEmailMessageRow = SelectResult<
  (typeof resendSchema)["tables"]["emailMessage"],
  {},
  true
>;
type ResendThreadRow = SelectResult<(typeof resendSchema)["tables"]["emailThread"], {}, true>;
type ResendMailboxRow = SelectResult<(typeof resendSchema)["tables"]["mailbox"], {}, true>;
type ResendServiceContext = DatabaseServiceContext<ResendHooksMap>;

const SEND_EMAIL_HOOK_ID_PREFIX = "resend:send-email:";
const MAX_DURABLE_HOOK_ID_LENGTH = 128;
export const MAX_RESEND_EMAIL_IDEMPOTENCY_KEY_LENGTH =
  MAX_DURABLE_HOOK_ID_LENGTH - SEND_EMAIL_HOOK_ID_PREFIX.length;

const isEmailWebhookEvent = (event: WebhookEventPayload): event is ResendEmailWebhookEvent =>
  event.type.startsWith("email.");

const isReceivedEmailWebhookEvent = (
  event: WebhookEventPayload,
): event is ResendReceivedEmailWebhookEvent => event.type === "email.received";

const statusFromWebhookEvent = (event: ResendEmailWebhookEvent) => {
  return event.type.replace("email.", "");
};

/** `position` is the reached mailbox's position in the message's recipient mailboxes, if any. */
const buildReceivedEmailDeliveryHookId = (emailMessageId: string, position: number | null) => {
  return position === null
    ? `deliver-email-received:${emailMessageId}`
    : `deliver-email-received:${emailMessageId}:${position}`;
};

/** The mailboxes a received message reached; none for sent messages. */
const readRecipientMailboxes = (stored: unknown): ResendMailboxMatch[] =>
  (stored as ResendMailboxMatch[] | null | undefined) ?? [];

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

/** Resend errors another attempt can get past: rate limits, and failures on Resend's side. */
const RETRYABLE_RESEND_ERRORS: ReadonlySet<string> = new Set([
  "rate_limit_exceeded",
  "concurrent_idempotent_requests",
  "application_error",
  "internal_server_error",
]);

const isRetryableResendError = (error: ErrorResponse) =>
  RETRYABLE_RESEND_ERRORS.has(error.name) || error.statusCode === null || error.statusCode >= 500;

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

function toMailbox(row: ResendMailboxRow): ResendMailbox {
  return {
    owner: row.owner,
    address: row.address,
    paused: row.pausedAt !== null,
  };
}

const sortThreadsByRecent = (threads: ResendThreadRow[]) => {
  return threads.toSorted((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
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
          messageCount: (existingThread.messageCount ?? 0) + 1,
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

const createResendServiceMethods = (config: ResendFragmentConfig) => {
  /** Delivers a mailbox change in the transaction that makes it, so it is never lost. */
  const announceMailboxChange = (
    uow: Pick<TypedUnitOfWork<typeof resendSchema, [], unknown, ResendHooksMap>, "triggerHook">,
    mailbox: ResendMailbox,
  ) => {
    if (config.onMailboxChanged) {
      uow.triggerHook("deliverMailboxChanged", mailbox);
    }
  };

  const services = defineResendServiceMethods({
    queueEmail: function (input: ResendSendEmailInput, options: { idempotencyKey?: string } = {}) {
      const payload = resolveEmailPayload(input, config);
      if (!payload.from) {
        throw new Error("Missing from address. Provide it in the request or config.defaultFrom.");
      }

      const idempotencyKey = options.idempotencyKey?.trim();
      if (idempotencyKey && idempotencyKey.length > MAX_RESEND_EMAIL_IDEMPOTENCY_KEY_LENGTH) {
        throw new Error(
          `Idempotency key must be at most ${MAX_RESEND_EMAIL_IDEMPOTENCY_KEY_LENGTH} characters.`,
        );
      }

      const now = new Date();
      const sendEmailHookId = idempotencyKey
        ? `${SEND_EMAIL_HOOK_ID_PREFIX}${idempotencyKey}`
        : undefined;

      return this.serviceTx(resendSchema)
        .mutate(({ uow }) => {
          const scheduledAtValue = input.scheduledIn ? uow.now().plus(input.scheduledIn) : null;
          const status = scheduledAtValue ? "scheduled" : "queued";
          const emailId = uow.create("emailMessage", {
            direction: "outbound",
            threadId: null,
            status,
            providerEmailId: null,
            from: payload.from ?? null,
            to: toArray(payload.to) ?? [],
            cc: toArray(payload.cc) ?? null,
            bcc: toArray(payload.bcc) ?? null,
            replyTo: toArray(payload.replyTo) ?? null,
            subject: payload.subject ?? null,
            messageId: null,
            headers: payload.headers ?? null,
            html: payload.html ?? null,
            text: payload.text ?? null,
            attachments: null,
            tags: payload.tags ?? null,
            occurredAt: uow.now(),
            scheduledAt: scheduledAtValue,
            sentAt: null,
            lastEventType: null,
            lastEventAt: null,
            errorCode: null,
            errorMessage: null,
          });

          uow.triggerHook(
            "sendEmail",
            { emailId: emailId.valueOf() },
            {
              ...(sendEmailHookId ? { id: sendEmailHookId } : {}),
              ...(scheduledAtValue ? { processAt: scheduledAtValue } : {}),
            },
          );

          return {
            id: emailId.valueOf(),
            status,
            resendId: null,
            createdAt: now,
            updatedAt: now,
          };
        })
        .build();
    },

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
              .joinOne("emailMessageThread", "emailThread", (thread) =>
                thread.onIndex("primary", (eb) => eb("id", "=", eb.parent("threadId"))),
              ),
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

    /** The owner's mailbox, paused or not; null when it has none. */
    getMailbox: function (owner: string) {
      return this.serviceTx(resendSchema)
        .retrieve((uow) =>
          uow.findFirst("mailbox", (b) =>
            b.whereIndex("idx_mailbox_owner", (eb) => eb("owner", "=", owner)),
          ),
        )
        .transformRetrieve(([row]) => (row ? toMailbox(row) : null))
        .build();
    },

    /**
     * Gives the owner its mailbox, resumed if paused. Only an owner without one gets `address`, so
     * an owner keeps one address however often it opens its mailbox.
     */
    openMailbox: function ({ owner, address }: { owner: string; address: string }) {
      const parsed = parseMailboxAddress(address);
      if (!parsed.ok) {
        return this.serviceTx(resendSchema)
          .mutate((): ResendOpenMailboxResult => ({ status: "invalid", message: parsed.message }))
          .build();
      }

      return this.serviceTx(resendSchema)
        .retrieve((uow) =>
          uow
            .findFirst("mailbox", (b) =>
              b.whereIndex("idx_mailbox_owner", (eb) => eb("owner", "=", owner)),
            )
            .findFirst("mailboxAddress", (b) =>
              b.whereIndex("idx_mailboxAddress_address", (eb) =>
                eb("address", "=", parsed.address),
              ),
            ),
        )
        .mutate(({ uow, retrieveResult: [mailbox, issued] }): ResendOpenMailboxResult => {
          if (mailbox) {
            const opened = { ...toMailbox(mailbox), paused: false };
            if (mailbox.pausedAt) {
              uow.update("mailbox", mailbox.id, (b) => b.set({ pausedAt: null }).check());
              announceMailboxChange(uow, opened);
            }
            return { status: "opened", mailbox: opened };
          }
          if (issued) {
            return { status: "taken" };
          }
          // A concurrent open for this owner or address that commits first fails these checks, so
          // the retry reads its mailbox or issued address instead of breaking a unique index.
          uow.checkAbsent("mailbox", "idx_mailbox_owner", { owner });
          uow.checkAbsent("mailboxAddress", "idx_mailboxAddress_address", {
            address: parsed.address,
          });
          uow.create("mailboxAddress", { address: parsed.address, owner });
          uow.create("mailbox", { owner, address: parsed.address, pausedAt: null });
          const opened = { owner, address: parsed.address, paused: false };
          announceMailboxChange(uow, opened);
          return { status: "opened", mailbox: opened };
        })
        .build();
    },

    /** Stops delivery; the mailbox keeps its address, so opening it again resumes it. */
    pauseMailbox: function (owner: string) {
      return this.serviceTx(resendSchema)
        .retrieve((uow) =>
          uow.findFirst("mailbox", (b) =>
            b.whereIndex("idx_mailbox_owner", (eb) => eb("owner", "=", owner)),
          ),
        )
        .mutate(({ uow, retrieveResult: [mailbox] }): ResendPauseMailboxResult => {
          if (!mailbox) {
            return { status: "not-found" };
          }
          if (!mailbox.pausedAt) {
            uow.update("mailbox", mailbox.id, (b) => b.set({ pausedAt: uow.now() }).check());
            announceMailboxChange(uow, { ...toMailbox(mailbox), paused: true });
          }
          return { status: "paused" };
        })
        .build();
    },

    /** Moves the owner's mailbox to a new address; the old one is never issued again. */
    replaceMailboxAddress: function ({ owner, address }: { owner: string; address: string }) {
      const parsed = parseMailboxAddress(address);
      if (!parsed.ok) {
        return this.serviceTx(resendSchema)
          .mutate(
            (): ResendReplaceMailboxAddressResult => ({
              status: "invalid",
              message: parsed.message,
            }),
          )
          .build();
      }

      return this.serviceTx(resendSchema)
        .retrieve((uow) =>
          uow
            .findFirst("mailbox", (b) =>
              b.whereIndex("idx_mailbox_owner", (eb) => eb("owner", "=", owner)),
            )
            .findFirst("mailboxAddress", (b) =>
              b.whereIndex("idx_mailboxAddress_address", (eb) =>
                eb("address", "=", parsed.address),
              ),
            ),
        )
        .mutate(({ uow, retrieveResult: [mailbox, issued] }): ResendReplaceMailboxAddressResult => {
          if (!mailbox) {
            return { status: "not-found" };
          }
          if (issued) {
            return { status: "taken" };
          }
          uow.checkAbsent("mailboxAddress", "idx_mailboxAddress_address", {
            address: parsed.address,
          });
          uow.create("mailboxAddress", { address: parsed.address, owner });
          uow.update("mailbox", mailbox.id, (b) => b.set({ address: parsed.address }).check());
          const replaced = { ...toMailbox(mailbox), address: parsed.address };
          announceMailboxChange(uow, replaced);
          return { status: "replaced", mailbox: replaced };
        })
        .build();
    },

    /** A received message, only for an owner of a mailbox it was delivered to. */
    getMailboxEmail: function ({
      emailMessageId,
      owner,
    }: {
      emailMessageId: string;
      owner: string;
    }) {
      return this.serviceTx(resendSchema)
        .retrieve((uow) =>
          uow.findFirst("emailMessage", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", emailMessageId)),
          ),
        )
        .transformRetrieve(([email]): ResendMailboxEmail | null => {
          const recipientMailbox = readRecipientMailboxes(email?.recipientMailboxes).find(
            (match) => match.owner === owner,
          );
          if (!email || !recipientMailbox) {
            return null;
          }
          const { threadId } = email;
          // Every received message is threaded on receipt.
          if (threadId === null) {
            throw new Error(`Received email ${emailMessageId} has no thread.`);
          }
          return { ...buildThreadMessage({ ...email, threadId }), recipientMailbox };
        })
        .build();
    },

    /** The owner an address delivers to; null unless it is a mailbox's current, unpaused address. */
    findMailbox: function (address: string) {
      return this.serviceTx(resendSchema)
        .retrieve((uow) =>
          uow.findFirst("mailbox", (b) =>
            b.whereIndex("idx_mailbox_address", (eb) =>
              eb("address", "=", normalizeMailboxAddress(address)),
            ),
          ),
        )
        .transformRetrieve(([row]): ResendMailboxMatch | null =>
          row && !row.pausedAt ? { address: row.address, owner: row.owner } : null,
        )
        .build();
    },
  });

  return services;
};

const createResendServices = (
  defineService: <T>(svc: T & ThisType<ResendServiceContext>) => T,
  config: ResendFragmentConfig,
) => {
  return defineService(createResendServiceMethods(config));
};

export const resendFragmentDefinition = defineFragment<ResendFragmentConfig>("resend")
  .extend(withDatabase(resendSchema))
  .withDependencies(({ config }) => ({
    resend: config.client ?? new Resend(config.apiKey),
  }))
  .providesBaseService(({ defineService, config }) => createResendServices(defineService, config))
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

          const status = email.status;
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

      // The hook's own ID, not its transaction's nonce: one transaction may queue several emails,
      // and each needs its own key, kept across the hook's retries.
      const resendIdempotencyKey = this.hookId.externalId;
      const lastAttempt = this.attempts + 1 >= this.maxAttempts;

      // Nothing else writes the claimed email until Resend's ID is on it, since webhooks find it by
      // that ID, so the result is written by ID alone, without reading the email again.
      const updateEmail = async (write: (uow: ResendUow, id: string) => void) => {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            write(forSchema(resendSchema), prepared.email.id);
          })
          .execute();
      };

      // A failure Resend may get past, such as a rate limit, waits for the hook's next attempt;
      // Resend's idempotency key keeps a retry from sending the email twice. Any other failure, or
      // the last attempt's, is final.
      const fail = async (
        { code, message }: { code: string; message: string },
        retryable: boolean,
      ) => {
        const retry = retryable && !lastAttempt;
        await updateEmail((uow, id) => {
          uow.update("emailMessage", id, (b) =>
            b.set({
              status: retry ? "queued" : "failed",
              updatedAt: uow.now(),
              errorCode: code,
              errorMessage: message,
            }),
          );
        });
        if (retry) {
          throw new Error(`Resend did not accept email ${prepared.email.id}: ${message} (${code})`);
        }
      };

      let response;
      try {
        response = await deps.resend.emails.send(prepared.email.payload, {
          idempotencyKey: resendIdempotencyKey,
        });
      } catch (error) {
        // Thrown errors are the network's or the client's, not Resend's verdict on the email.
        await fail(formatResendError(error), true);
        return;
      }

      if (response.error) {
        await fail(formatResendApiError(response.error), isRetryableResendError(response.error));
        return;
      }

      if (!response.data) {
        await fail({ code: "missing_response", message: "Resend returned no data" }, true);
        return;
      }

      await updateEmail((uow, id) => {
        const now = uow.now();
        uow.update("emailMessage", id, (b) =>
          b.set({
            providerEmailId: response.data.id,
            status: "sent",
            sentAt: now,
            updatedAt: now,
            // lastEventAt is the time of Resend's latest event, which later webhooks are measured
            // against. A retry may learn of an acceptance well after it happened, so this write's
            // own time leaves it alone, and no event Resend reported after acceptance looks stale.
            lastEventType: "email.sent",
            errorCode: null,
            errorMessage: null,
          }),
        );
      });
    }),
    deliverEmailReceived: defineHook(async function ({
      event,
      emailMessageId,
      threadId,
      threadResolvedVia,
      recipientMailbox,
      authentication,
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
        recipientMailbox,
        authentication: authentication ?? null,
        receivedAt: event.data.created_at,
        webhookReceivedAt: event.created_at,
        threadId,
        threadResolvedVia,
        eventType: event.type,
        event,
        // One transaction delivers to every owner an email reached, so its key would repeat;
        // each delivery's hook ID is its own.
        idempotencyKey: this.hookId.externalId,
      });
    }),
    deliverMailboxChanged: defineHook(async function (mailbox) {
      await config.onMailboxChanged?.(mailbox, this);
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
        const authentication = readEmailAuthentication(receivedDetail.authentication);
        // The event names the recipients Resend delivered it to; the message's own To header may
        // name others, such as the original recipient of a forwarded message.
        const recipients = [
          ...new Set(event.data.to.flatMap((recipient) => extractMailbox(recipient) ?? [])),
        ];

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
              ...recipients.map((recipient) => services.findMailbox(recipient)),
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
              [replyTokenThread, inReplyToThread, referencesThread, heuristicThread, ...matches],
            ) => ({
              existingMessage,
              replyTokenThread: replyTokenThread ?? null,
              inReplyToThread: inReplyToThread ?? null,
              referencesThread: referencesThread ?? null,
              heuristicThread: heuristicThread ?? null,
              // One per owner: an owner's single mailbox has one current address.
              recipientMailboxes: matches.filter(
                (match, index): match is ResendMailboxMatch =>
                  match !== null &&
                  matches.findIndex((other) => other?.owner === match.owner) === index,
              ),
            }),
          )
          .mutate(({ forSchema, retrieveResult }) => {
            const {
              existingMessage,
              replyTokenThread,
              inReplyToThread,
              referencesThread,
              heuristicThread,
              recipientMailboxes,
            } = retrieveResult;

            const { thread: resolvedThread, threadResolvedVia } = resolveInboundThread({
              replyTokenThread,
              inReplyToThread,
              referencesThread,
              heuristicThread,
            });

            const uow = forSchema(resendSchema);
            /** One delivery per owner reached, numbered from `first` in the message's list. */
            const deliver = (
              emailMessageId: string,
              threadId: string,
              matches: ResendMailboxMatch[],
              first: number,
            ) => {
              if (!config.onEmailReceived) {
                return;
              }
              const deliveries =
                matches.length === 0
                  ? [{ recipientMailbox: null, position: null }]
                  : matches.map((match, index) => ({
                      recipientMailbox: match,
                      position: first + index,
                    }));
              for (const { recipientMailbox, position } of deliveries) {
                uow.triggerHook(
                  "deliverEmailReceived",
                  {
                    event,
                    emailMessageId,
                    threadId,
                    threadResolvedVia,
                    recipientMailbox,
                    authentication,
                  },
                  { id: buildReceivedEmailDeliveryHookId(emailMessageId, position) },
                );
              }
            };

            if (existingMessage) {
              // Resend may report one message again, such as once per recipient: deliver it only
              // to owners it has not reached. Their delivery reports how the thread resolves now.
              const reached = readRecipientMailboxes(existingMessage.recipientMailboxes);
              const added = recipientMailboxes.filter(
                (match) => !reached.some(({ owner }) => owner === match.owner),
              );
              if (added.length === 0 || existingMessage.threadId === null) {
                return;
              }
              uow.update("emailMessage", existingMessage.id, (b) =>
                b.set({ recipientMailboxes: [...reached, ...added], updatedAt: uow.now() }).check(),
              );
              deliver(
                existingMessage.id.valueOf(),
                String(existingMessage.threadId.valueOf()),
                added,
                reached.length,
              );
              return;
            }

            const threadSummary = appendToThreadSummary(uow, resolvedThread, {
              subject: receivedDetail.subject,
              normalizedSubject: inbound.normalizedSubject,
              participants: inbound.participants,
              occurredAt: receivedAt,
              direction: "inbound",
              preview: inbound.preview,
            });

            // A received message takes Resend's email ID, so a concurrent report of the same email
            // that commits first fails this check, and the retry reads its message instead of
            // storing another.
            uow.checkAbsent("emailMessage", "primary", { id: receivedDetail.id });
            const emailMessageId = uow.create("emailMessage", {
              id: receivedDetail.id,
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
              recipientMailboxes,
              authentication,
            });

            deliver(
              emailMessageId.valueOf(),
              String(threadSummary.threadId),
              recipientMailboxes,
              0,
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
