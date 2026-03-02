import type { HookContext } from "@fragno-dev/db";
import { telegramSchema } from "./schema";
import { telegramMessageSchema } from "./types";
import type { TelegramApi, TelegramApiResult, TelegramMessage, TelegramUpdateType } from "./types";
import { createUpsertOutgoingMessageOps } from "./services";

const persistOutgoingMessage = async (
  handlerTx: HookContext["handlerTx"],
  message: TelegramMessage,
  messageType: TelegramUpdateType,
) => {
  try {
    const ops = createUpsertOutgoingMessageOps({ message, messageType });
    await handlerTx()
      .retrieve(({ forSchema }) => ops.retrieve(forSchema(telegramSchema)))
      .mutate(({ forSchema, retrieveResult }) =>
        ops.mutate({ uow: forSchema(telegramSchema), retrieveResult }),
      )
      .execute();
  } catch (error) {
    console.error("telegram outgoing message persist error", error);
  }
};

export const createCommandHandlerApi = (
  api: TelegramApi,
  handlerTx: HookContext["handlerTx"],
): TelegramApi => {
  const persistFromResult = async (method: string, result: TelegramApiResult<unknown>) => {
    if (!result.ok) {
      return;
    }
    const parsed = telegramMessageSchema.safeParse(result.result);
    if (!parsed.success) {
      return;
    }
    const normalized = method.toLowerCase();
    const messageType: TelegramUpdateType = normalized.startsWith("editmessage")
      ? "edited_message"
      : "message";
    await persistOutgoingMessage(handlerTx, parsed.data, messageType);
  };

  return {
    call: async <T>(method: string, payload: Record<string, unknown>) => {
      const result = await api.call<T>(method, payload);
      await persistFromResult(method, result);
      return result;
    },
    sendMessage: async (payload: Record<string, unknown>) => {
      const result = await api.sendMessage(payload);
      if (result.ok) {
        await persistOutgoingMessage(handlerTx, result.result, "message");
      }
      return result;
    },
    editMessageText: async (payload: Record<string, unknown>) => {
      const result = await api.editMessageText(payload);
      if (result.ok) {
        await persistOutgoingMessage(handlerTx, result.result, "edited_message");
      }
      return result;
    },
    sendChatAction: (payload: Record<string, unknown>) => api.sendChatAction(payload),
  };
};
