import { defineFragment } from "@fragno-dev/core";
import { ExponentialBackoffRetryPolicy, withDatabase } from "@fragno-dev/db";
import { telegramSchema } from "./schema";
import type { TelegramFragmentConfig, TelegramHooksMap } from "./types";
import { createProcessIncomingUpdateOps, createTelegramServices } from "./services";
import { createTelegramApi } from "./telegram-api";
import { parseTelegramUpdate } from "./telegram-utils";

export const telegramFragmentDefinition = defineFragment<TelegramFragmentConfig>(
  "telegram-fragment",
)
  .extend(withDatabase(telegramSchema))
  .providesBaseService(({ defineService, config }) =>
    defineService({
      ...createTelegramServices(config),
    }),
  )
  .provideHooks<TelegramHooksMap>(({ defineHook, config }) => {
    const api = createTelegramApi(config);
    const hooks = config.hooks;
    const buildProcessIncomingUpdateOps = createProcessIncomingUpdateOps(config);

    return {
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

        const definition = (config.commands ?? {})[result.command.name];
        if (!definition) {
          return;
        }

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
          api,
          handlerTx: this.handlerTx,
        });
      }),
      onMessageReceived: defineHook(async function (payload) {
        await hooks?.onMessageReceived?.(payload);
      }),
      onCommandMatched: defineHook(async function (payload) {
        await hooks?.onCommandMatched?.(payload);
      }),
      onChatMemberUpdated: defineHook(async function (payload) {
        await hooks?.onChatMemberUpdated?.(payload);
      }),
    };
  })
  .build();
