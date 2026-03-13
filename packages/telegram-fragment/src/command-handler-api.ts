import type { HookHandlerTx } from "@fragno-dev/db";
import { telegramSchema } from "./schema";
import type {
  TelegramApi,
  TelegramCommandApi,
  TelegramHooksMap,
  TelegramOutgoingHookPayload,
  TelegramQueuedResult,
} from "./types";

type OutgoingQueueItem = TelegramOutgoingHookPayload;

export const createCommandHandlerApi = (
  api: TelegramApi,
  handlerTx: HookHandlerTx,
): { api: TelegramCommandApi; flush: () => Promise<void> } => {
  const queue: OutgoingQueueItem[] = [];

  const enqueue = (
    action: TelegramOutgoingHookPayload["action"],
    payload: Record<string, unknown>,
  ): TelegramQueuedResult => {
    queue.push({ action, payload });
    return { ok: true, queued: true };
  };

  const flush = async () => {
    if (queue.length === 0) {
      return;
    }
    const entries = queue.splice(0, queue.length);
    await handlerTx()
      .mutate(({ forSchema }) => {
        const uow = forSchema(telegramSchema, {} as TelegramHooksMap);
        for (const payload of entries) {
          uow.triggerHook("internalOutgoingMessage", payload);
        }
      })
      .execute();
  };

  const commandApi: TelegramCommandApi = {
    call: async <T>(method: string, payload: Record<string, unknown>) => {
      const normalized = method.toLowerCase();
      if (normalized === "sendmessage") {
        return enqueue("sendMessage", payload);
      }
      if (normalized === "editmessagetext") {
        return enqueue("editMessageText", payload);
      }
      return api.call<T>(method, payload);
    },
    sendMessage: async (payload: Record<string, unknown>) => enqueue("sendMessage", payload),
    editMessageText: async (payload: Record<string, unknown>) =>
      enqueue("editMessageText", payload),
    sendChatAction: (payload: Record<string, unknown>) => api.sendChatAction(payload),
  };

  return { api: commandApi, flush };
};
