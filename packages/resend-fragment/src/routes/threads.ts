import { z } from "zod";

import { type TypedUnitOfWork } from "@fragno-dev/db";

import type { ResendFragmentConfig } from "../definition";
import { resendSchema } from "../schema";
import {
  buildHeuristicKey,
  buildParticipantKey,
  buildPreviewText,
  buildThreadMessageId,
  buildThreadReplyAddress,
  buildThreadReplyToList,
  normalizeParticipants,
  normalizeSubject,
  asStringArray,
  asAddressList,
} from "../threading";
import type {
  ResendRouteFactoryContext,
  ResendRouteHandlerContext,
  ResendThreadRow,
} from "./context";
import { resendSendEmailInputSchema } from "./emails";
import {
  addressListSchema,
  resolveThreadEmailPayload,
  safeDecodeCursor,
  buildThreadDetail,
  buildThreadSummary,
  buildThreadMessage,
  formatErrorMessage,
} from "./shared";

export const resendThreadMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  status: z.string(),
  from: z.string().nullable(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  replyTo: z.array(z.string()),
  subject: z.string().nullable(),
  normalizedSubject: z.string(),
  participants: z.array(z.string()),
  messageId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  providerEmailId: z.string().nullable(),
  attachments: z.array(
    z.object({
      id: z.string(),
      filename: z.string().nullable(),
      size: z.number().int().nonnegative(),
      contentType: z.string(),
      contentDisposition: z.string().nullable(),
      contentId: z.string().nullable(),
    }),
  ),
  html: z.string().nullable(),
  text: z.string().nullable(),
  headers: z.record(z.string(), z.string()).nullable(),
  occurredAt: z.date(),
  scheduledAt: z.date().nullable(),
  sentAt: z.date().nullable(),
  lastEventType: z.string().nullable(),
  lastEventAt: z.date().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const resendThreadSummarySchema = z.object({
  id: z.string(),
  subject: z.string().nullable(),
  normalizedSubject: z.string(),
  participants: z.array(z.string()),
  messageCount: z.number().int().nonnegative(),
  firstMessageAt: z.date(),
  lastMessageAt: z.date(),
  lastDirection: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const resendThreadDetailSchema = resendThreadSummarySchema.extend({
  replyToAddress: z.string().nullable(),
});

const resendThreadReplyInputSchema = z
  .object({
    from: z.string().min(1).optional(),
    to: addressListSchema,
    subject: z.string().min(1).optional(),
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
    scheduledIn: z
      .object({
        ms: z.coerce.number().int().positive().optional(),
        seconds: z.coerce.number().int().positive().optional(),
        minutes: z.coerce.number().int().positive().optional(),
        hours: z.coerce.number().int().positive().optional(),
        days: z.coerce.number().int().positive().optional(),
      })
      .refine(
        (value) => Object.values(value).some((entry) => typeof entry === "number" && entry > 0),
        {
          message: "scheduledIn must include a positive interval value.",
        },
      )
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.html && !value.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either html or text is required.",
        path: ["html"],
      });
    }
  });

export const resendListThreadsOutputSchema = z.object({
  threads: z.array(resendThreadSummarySchema),
  cursor: z.string().optional(),
  hasNextPage: z.boolean(),
});

export const resendListThreadMessagesOutputSchema = z.object({
  messages: z.array(resendThreadMessageSchema),
  cursor: z.string().optional(),
  hasNextPage: z.boolean(),
});

export const resendThreadMutationOutputSchema = z.object({
  thread: resendThreadDetailSchema,
  message: resendThreadMessageSchema,
});

export type ResendThreadSummary = z.infer<typeof resendThreadSummarySchema>;
export type ResendThreadDetail = z.infer<typeof resendThreadDetailSchema>;
export type ResendThreadMessage = z.infer<typeof resendThreadMessageSchema>;
export type ResendListThreadsOutput = z.infer<typeof resendListThreadsOutputSchema>;
export type ResendListThreadMessagesOutput = z.infer<typeof resendListThreadMessagesOutputSchema>;
export type ResendThreadMutationOutput = z.infer<typeof resendThreadMutationOutputSchema>;
export type ResendThreadReplyInput = z.infer<typeof resendThreadReplyInputSchema>;

type ResendUow = TypedUnitOfWork<typeof resendSchema>;

const resendListThreadsQuerySchema = z.object({
  cursor: z.string().optional(),
  pageSize: z.coerce.number().min(1).max(100).catch(100),
  order: z.enum(["asc", "desc"]).catch("asc"),
});

const getRouteErrorCode = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }

  const { code } = error;
  return typeof code === "string" ? code : null;
};

const resolveScheduledAt = (
  occurredAt: Date,
  scheduledIn?: ResendThreadReplyInput["scheduledIn"],
) => {
  if (!scheduledIn) {
    return null;
  }

  const offsetMs =
    (scheduledIn.ms ?? 0) +
    (scheduledIn.seconds ?? 0) * 1_000 +
    (scheduledIn.minutes ?? 0) * 60_000 +
    (scheduledIn.hours ?? 0) * 3_600_000 +
    (scheduledIn.days ?? 0) * 86_400_000;

  return new Date(occurredAt.getTime() + offsetMs);
};

const appendToThreadSummary = (
  uow: ResendUow,
  currentThread: ResendThreadRow | null,
  input: {
    threadId: string;
    subject: string;
    normalizedSubject: string;
    participants: string[];
    occurredAt: Date;
    preview: string | null;
    replyToken: string;
  },
) => {
  const nextParticipants = currentThread
    ? normalizeParticipants([...asStringArray(currentThread.participants), ...input.participants])
    : input.participants;
  const participantKey = buildParticipantKey(nextParticipants);
  const heuristicKey = buildHeuristicKey(input.normalizedSubject, participantKey);

  if (currentThread) {
    uow.update("emailThread", currentThread.id, (b) =>
      b
        .set({
          subject: currentThread.subject ?? input.subject,
          normalizedSubject: currentThread.normalizedSubject,
          participants: nextParticipants,
          heuristicKey,
          messageCount: Number(currentThread.messageCount ?? 0) + 1,
          lastMessageAt: input.occurredAt,
          lastDirection: "outbound",
          lastMessagePreview: input.preview,
        })
        .check(),
    );

    return {
      threadId: currentThread.id,
      subject: currentThread.subject ?? input.subject,
      normalizedSubject: currentThread.normalizedSubject,
      participants: nextParticipants,
      messageCount: Number(currentThread.messageCount ?? 0) + 1,
      firstMessageAt: currentThread.firstMessageAt,
      lastMessageAt: input.occurredAt,
      lastDirection: "outbound" as const,
      lastMessagePreview: input.preview,
      replyToken: currentThread.replyToken,
      createdAt: currentThread.firstMessageAt,
      updatedAt: input.occurredAt,
    };
  }

  const threadId = uow.create("emailThread", {
    id: input.threadId,
    subject: input.subject,
    normalizedSubject: input.normalizedSubject,
    participants: nextParticipants,
    heuristicKey,
    replyToken: input.replyToken,
    messageCount: 1,
    firstMessageAt: input.occurredAt,
    lastMessageAt: input.occurredAt,
    lastDirection: "outbound",
    lastMessagePreview: input.preview,
  });

  return {
    threadId,
    subject: input.subject,
    normalizedSubject: input.normalizedSubject,
    participants: nextParticipants,
    messageCount: 1,
    firstMessageAt: input.occurredAt,
    lastMessageAt: input.occurredAt,
    lastDirection: "outbound" as const,
    lastMessagePreview: input.preview,
    replyToken: input.replyToken,
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
  };
};

const queueThreadMessage = async function (
  this: ResendRouteHandlerContext,
  rawEmail: ResendThreadReplyInput,
  config: ResendFragmentConfig,
  options?: {
    existingThreadId?: string;
  },
): Promise<ResendThreadMutationOutput> {
  const existingThreadId = options?.existingThreadId;
  const occurredAt = new Date();
  const fallbackThreadId = crypto.randomUUID();
  const fallbackReplyToken = crypto.randomUUID().replace(/-/g, "");
  const threadLookupId = existingThreadId ?? fallbackThreadId;

  const scheduledAt = resolveScheduledAt(occurredAt, rawEmail.scheduledIn);

  const createResult = await this.handlerTx()
    .retrieve(({ forSchema }) =>
      forSchema(resendSchema)
        .findFirst("emailThread", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", threadLookupId)),
        )
        .find("emailMessage", (b) =>
          b
            .whereIndex("idx_emailMessage_thread_occurredAt", (eb) =>
              eb("threadId", "=", threadLookupId),
            )
            .orderByIndex("idx_emailMessage_thread_occurredAt", "asc"),
        ),
    )
    .transformRetrieve(([thread, messages]) => ({
      thread: thread ?? null,
      messages,
    }))
    .mutate(({ forSchema, retrieveResult: existingThread }) => {
      const payload = resolveThreadEmailPayload(
        rawEmail,
        config,
        existingThread.thread?.subject ?? null,
      );
      if (!payload.from) {
        throw Object.assign(
          new Error("Missing from address. Provide it in the request or config.defaultFrom."),
          {
            code: "MISSING_FROM",
          },
        );
      }

      if (!payload.subject) {
        throw Object.assign(
          new Error(
            "Missing subject. Provide it in the request or create the thread with a subject.",
          ),
          {
            code: "MISSING_SUBJECT",
          },
        );
      }

      if (existingThreadId && !existingThread.thread) {
        throw Object.assign(new Error("Thread not found."), { code: "THREAD_NOT_FOUND" });
      }

      const priorMessageIds = existingThread.messages
        .map((message) => message.messageId)
        .filter((value): value is string => typeof value === "string");
      const parentMessageId = [...priorMessageIds].reverse()[0] ?? null;
      const referencesHeader = priorMessageIds.join(" ");
      const subject = payload.subject;
      const normalizedSubjectValue =
        existingThread.thread?.normalizedSubject ?? normalizeSubject(subject);
      const plannedThreadId = existingThread.thread?.id.valueOf() ?? fallbackThreadId;
      const replyToken = existingThread.thread?.replyToken ?? fallbackReplyToken;
      const replyTo = buildThreadReplyToList(replyToken, config, asAddressList(payload.replyTo));
      const messageId = buildThreadMessageId(plannedThreadId, config);
      const to = asAddressList(payload.to);
      const cc = asAddressList(payload.cc);
      const bcc = asAddressList(payload.bcc);
      const participants = normalizeParticipants([payload.from, ...to, ...cc, ...bcc]);
      const preview = buildPreviewText(payload.text, payload.html);
      const headers = {
        ...payload.headers,
        "Message-ID": messageId,
        ...(parentMessageId ? { "In-Reply-To": parentMessageId } : {}),
        ...(referencesHeader ? { References: referencesHeader } : {}),
      };

      const uow = forSchema(resendSchema);
      const scheduledAtValue = rawEmail.scheduledIn ? uow.now().plus(rawEmail.scheduledIn) : null;
      const status = scheduledAtValue ? "scheduled" : "queued";
      const currentThread = existingThread.thread;
      const threadSummary = appendToThreadSummary(uow, currentThread, {
        threadId: plannedThreadId,
        subject,
        normalizedSubject: normalizedSubjectValue,
        participants,
        occurredAt,
        preview,
        replyToken,
      });

      const emailMessageId = uow.create("emailMessage", {
        threadId: threadSummary.threadId,
        direction: "outbound",
        status,
        providerEmailId: null,
        from: payload.from ?? null,
        to,
        cc: cc.length > 0 ? cc : null,
        bcc: bcc.length > 0 ? bcc : null,
        replyTo: replyTo ?? null,
        subject,
        messageId,
        headers,
        html: payload.html ?? null,
        text: payload.text ?? null,
        attachments: null,
        tags: payload.tags ?? null,
        occurredAt,
        scheduledAt: scheduledAtValue ?? null,
        sentAt: null,
        lastEventType: null,
        lastEventAt: null,
        errorCode: null,
        errorMessage: null,
      });

      uow.triggerHook(
        "sendEmail",
        { emailId: emailMessageId.valueOf() },
        scheduledAtValue ? { processAt: scheduledAtValue } : undefined,
      );

      const message = buildThreadMessage({
        id: emailMessageId,
        threadId: threadSummary.threadId,
        direction: "outbound",
        status,
        providerEmailId: null,
        from: payload.from ?? null,
        to,
        cc: cc.length > 0 ? cc : null,
        bcc: bcc.length > 0 ? bcc : null,
        replyTo: replyTo ?? null,
        subject,
        messageId,
        attachments: null,
        html: payload.html ?? null,
        text: payload.text ?? null,
        headers,
        occurredAt,
        scheduledAt,
        sentAt: null,
        lastEventType: null,
        lastEventAt: null,
        errorCode: null,
        errorMessage: null,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      });

      return {
        thread: {
          id: String(threadSummary.threadId.valueOf()),
          subject: threadSummary.subject,
          normalizedSubject: threadSummary.normalizedSubject,
          participants: threadSummary.participants,
          messageCount: threadSummary.messageCount,
          firstMessageAt: threadSummary.firstMessageAt,
          lastMessageAt: threadSummary.lastMessageAt,
          lastDirection: threadSummary.lastDirection,
          lastMessagePreview: threadSummary.lastMessagePreview,
          replyToAddress: buildThreadReplyAddress(threadSummary.replyToken, config),
          createdAt: threadSummary.createdAt,
          updatedAt: threadSummary.updatedAt,
        },
        message,
      } satisfies ResendThreadMutationOutput;
    })
    .execute();

  return createResult;
};

const resendListThreadMessagesQuerySchema = z.object({
  cursor: z.string().optional(),
  pageSize: z.coerce.number().min(1).max(100).catch(100),
  order: z.enum(["asc", "desc"]).catch("asc"),
});

export const registerThreadRoutes = ({ defineRoute, config }: ResendRouteFactoryContext) => [
  defineRoute({
    method: "GET",
    path: "/threads",
    queryParameters: ["cursor", "pageSize", "order"],
    outputSchema: resendListThreadsOutputSchema,
    handler: async function ({ query }, { json }) {
      const parsed = resendListThreadsQuerySchema.parse({
        cursor: query.get("cursor") ?? undefined,
        pageSize: query.get("pageSize"),
        order: query.get("order"),
      });

      const indexName = "idx_emailThread_lastMessageAt";
      const cursor = parsed.cursor ? safeDecodeCursor(parsed.cursor, indexName) : undefined;

      const result = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(resendSchema).findWithCursor("emailThread", (b) => {
            const ordered = b
              .whereIndex(indexName)
              .orderByIndex(indexName, parsed.order)
              .pageSize(parsed.pageSize);
            return cursor ? ordered.after(cursor) : ordered;
          }),
        )
        .mutate(({ retrieveResult: [page] }) => ({
          threads: page.items.map((thread) => buildThreadSummary(thread)),
          cursor: page.cursor?.encode(),
          hasNextPage: page.hasNextPage,
        }))
        .execute();

      return json(result);
    },
  }),
  defineRoute({
    method: "POST",
    path: "/threads",
    inputSchema: resendSendEmailInputSchema,
    outputSchema: resendThreadMutationOutputSchema,
    errorCodes: ["MISSING_FROM", "MISSING_SUBJECT"] as const,
    handler: async function ({ input }, { json, error }) {
      const rawEmail = await input.valid();

      try {
        const result = await queueThreadMessage.call(this, rawEmail, config, undefined);
        return json(result);
      } catch (err) {
        const code = getRouteErrorCode(err);
        if (code === "MISSING_FROM") {
          return error({ message: formatErrorMessage(err), code: "MISSING_FROM" }, 400);
        }
        if (code === "MISSING_SUBJECT") {
          return error({ message: formatErrorMessage(err), code: "MISSING_SUBJECT" }, 400);
        }
        throw err;
      }
    },
  }),
  defineRoute({
    method: "GET",
    path: "/threads/:threadId",
    outputSchema: resendThreadDetailSchema,
    errorCodes: ["THREAD_NOT_FOUND"] as const,
    handler: async function ({ pathParams }, { json, error }) {
      const thread = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(resendSchema).findFirst("emailThread", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", pathParams.threadId)),
          ),
        )
        .transformRetrieve(([record]) => record ?? null)
        .execute();

      if (!thread) {
        return error(
          {
            message: "Thread not found.",
            code: "THREAD_NOT_FOUND",
          },
          404,
        );
      }

      return json(buildThreadDetail(thread, config, buildThreadReplyAddress));
    },
  }),
  defineRoute({
    method: "GET",
    path: "/threads/:threadId/messages",
    queryParameters: ["cursor", "pageSize", "order"],
    outputSchema: resendListThreadMessagesOutputSchema,
    errorCodes: ["THREAD_NOT_FOUND"] as const,
    handler: async function ({ pathParams, query }, { json, error }) {
      const parsed = resendListThreadMessagesQuerySchema.parse({
        cursor: query.get("cursor") ?? undefined,
        pageSize: query.get("pageSize"),
        order: query.get("order"),
      });
      const indexName = "idx_emailMessage_thread_occurredAt";
      const cursor = parsed.cursor ? safeDecodeCursor(parsed.cursor, indexName) : undefined;

      const result = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(resendSchema)
            .findFirst("emailThread", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", pathParams.threadId)),
            )
            .findWithCursor("emailMessage", (b) => {
              const ordered = b
                .whereIndex(indexName, (eb) => eb("threadId", "=", pathParams.threadId))
                .orderByIndex(indexName, parsed.order)
                .pageSize(parsed.pageSize);
              return cursor ? ordered.after(cursor) : ordered;
            }),
        )
        .mutate(({ retrieveResult: [thread, page] }) => {
          if (!thread) {
            return null;
          }

          return {
            messages: page.items.map((message) =>
              buildThreadMessage({
                ...message,
                threadId: message.threadId ?? pathParams.threadId,
              }),
            ),
            cursor: page.cursor?.encode(),
            hasNextPage: page.hasNextPage,
          };
        })
        .execute();

      if (!result) {
        return error(
          {
            message: "Thread not found.",
            code: "THREAD_NOT_FOUND",
          },
          404,
        );
      }

      return json(result);
    },
  }),
  defineRoute({
    method: "POST",
    path: "/threads/:threadId/reply",
    inputSchema: resendThreadReplyInputSchema,
    outputSchema: resendThreadMutationOutputSchema,
    errorCodes: ["THREAD_NOT_FOUND", "MISSING_FROM", "MISSING_SUBJECT"] as const,
    handler: async function ({ pathParams, input }, { json, error }) {
      const rawEmail = await input.valid();

      try {
        const result = await queueThreadMessage.call(this, rawEmail, config, {
          existingThreadId: pathParams.threadId,
        });
        return json(result);
      } catch (err) {
        const code = getRouteErrorCode(err);
        if (code === "THREAD_NOT_FOUND") {
          return error({ message: formatErrorMessage(err), code: "THREAD_NOT_FOUND" }, 404);
        }
        if (code === "MISSING_FROM") {
          return error({ message: formatErrorMessage(err), code: "MISSING_FROM" }, 400);
        }
        if (code === "MISSING_SUBJECT") {
          return error({ message: formatErrorMessage(err), code: "MISSING_SUBJECT" }, 400);
        }
        throw err;
      }
    },
  }),
];
