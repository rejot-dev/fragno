import { defineFragment } from "@fragno-dev/core";
import { ExponentialBackoffRetryPolicy, withDatabase } from "@fragno-dev/db";

import { createCommandHandlerApi } from "./command-handler-api";
import { telegramSchema } from "./schema";
import {
  createProcessIncomingUpdateOps,
  createTelegramServices,
  createUpsertOutgoingMessageOps,
} from "./services";
import { createTelegramApi } from "./telegram-api";
import { parseTelegramUpdate } from "./telegram-utils";
import type { TelegramFragmentConfig, TelegramFragmentDeps, TelegramHooksMap } from "./types";

const isTelegramEntityParseError = (result: {
  ok: false;
  errorCode?: number;
  description?: string;
}) => result.errorCode === 400 && result.description?.includes("can't parse entities");

const stripParseMode = (payload: Record<string, unknown>) => {
  const plainPayload = { ...payload };
  delete plainPayload["parseMode"];
  delete plainPayload["parse_mode"];
  return plainPayload;
};

export const telegramFragmentDefinition = defineFragment<TelegramFragmentConfig>(
  "telegram-fragment",
)
  .extend(withDatabase(telegramSchema))
  .withDependencies(
    ({ config }): TelegramFragmentDeps => ({
      telegramApi: config.api ?? createTelegramApi(config),
    }),
  )
  .providesBaseService(({ defineService, config }) =>
    defineService({
      ...createTelegramServices(config),
    }),
  )
  .provideHooks<TelegramHooksMap>(({ defineHook, config, deps }) => {
    const api = deps.telegramApi;
    const hooks = config.hooks;
    const buildProcessIncomingUpdateOps = createProcessIncomingUpdateOps(config);
    const hookContext = (context: { idempotencyKey: string; hookId: { toString(): string } }) => ({
      idempotencyKey: context.idempotencyKey,
      hookId: context.hookId.toString(),
    });

    return {
      internalOutgoingMessage: defineHook(async function (payload) {
        const messageType = payload.action === "editMessageText" ? "edited_message" : "message";
        let result =
          payload.action === "editMessageText"
            ? await api.editMessageText(payload.payload)
            : await api.sendMessage(payload.payload);

        if (!result.ok && isTelegramEntityParseError(result)) {
          const plainPayload = stripParseMode(payload.payload);
          result =
            payload.action === "editMessageText"
              ? await api.editMessageText(plainPayload)
              : await api.sendMessage(plainPayload);
        }

        if (!result.ok) {
          throw new Error(result.description ?? "Telegram API error");
        }

        // NOTE: Avoid throwing after the API call to minimize duplicate sends on retries.
        // TODO: Add a placeholder/intent record so we can keep the API call last without
        // risking a missing message record on persistence failures.
        try {
          const ops = createUpsertOutgoingMessageOps({
            message: result.result,
            messageType,
          });
          await this.handlerTx()
            .retrieve(({ forSchema }) => ops.retrieve(forSchema(telegramSchema)))
            .mutate(({ forSchema, retrieveResult }) =>
              ops.mutate({ uow: forSchema(telegramSchema), retrieveResult }),
            )
            .execute();
        } catch (error) {
          console.error("telegram outgoing message persist error", error);
        }
      }),
      internalProcessUpdate: defineHook(async function ({ update }) {
        const ops = buildProcessIncomingUpdateOps(update);
        const result =
          ops.kind === "ignored"
            ? ops
            : await this.handlerTx({
                retryPolicy: new ExponentialBackoffRetryPolicy({
                  maxRetries: 5,
                  initialDelayMs: 10,
                  maxDelayMs: 250,
                }),
              })
                .retrieve(({ forSchema }) => ops.retrieve(forSchema(telegramSchema)))
                .mutate(({ forSchema, retrieveResult }) =>
                  ops.mutate({ uow: forSchema(telegramSchema), retrieveResult }),
                )
                .transform(({ mutateResult }) => mutateResult)
                .execute();

        if (result.kind !== "message" || !result.command) {
          return;
        }

        const parsed = parseTelegramUpdate(update);
        if (!parsed) {
          return;
        }

        const definition = config.commands?.[result.command.name];
        if (!definition) {
          return;
        }

        const { api: handlerApi, flush } = createCommandHandlerApi(api, this.handlerTx);
        let handlerError: unknown;
        try {
          await definition.handler({
            updateId: result.updateId,
            idempotencyKey: this.idempotencyKey,
            update,
            message: parsed.message,
            chat: result.chat,
            fromUser: result.fromUser,
            command: {
              name: result.command.name,
              args: result.command.args,
              raw: result.command.raw,
            },
            api: handlerApi,
            handlerTx: this.handlerTx,
          });
        } catch (error) {
          handlerError = error;
        }

        try {
          await flush();
        } catch (error) {
          if (!handlerError) {
            throw error;
          }
          console.error("telegram outgoing message enqueue error", error);
        }

        if (handlerError) {
          throw handlerError;
        }
      }),
      onMessageReceived: defineHook(async function (payload) {
        await hooks?.onMessageReceived?.(payload, hookContext(this));
      }),
      onCommandMatched: defineHook(async function (payload) {
        await hooks?.onCommandMatched?.(payload, hookContext(this));
      }),
      onChatMemberUpdated: defineHook(async function (payload) {
        await hooks?.onChatMemberUpdated?.(payload, hookContext(this));
      }),
    };
  })
  .build();
