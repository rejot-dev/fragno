import { describe, expect, test, vi } from "vitest";
import type { HookHandlerTx } from "@fragno-dev/db";
import type { TelegramApi } from "./types";
import { createCommandHandlerApi } from "./command-handler-api";

const buildHandlerTx = () => {
  const triggered: Array<{ hookName: string; payload: unknown }> = [];
  type TriggerHookFn = (hookName: string, payload: unknown) => void;
  type ForSchemaFn = (..._args: unknown[]) => { triggerHook: TriggerHookFn };
  type MutateFn = (ctx: { forSchema: ForSchemaFn }) => void;
  const handlerTx = vi.fn(() => {
    const builder = {
      mutate: vi.fn((fn: MutateFn) => {
        fn({
          forSchema: () => ({
            triggerHook: (hookName: string, payload: unknown) => {
              triggered.push({ hookName, payload });
            },
          }),
        });
        return builder;
      }),
      execute: vi.fn(async () => {}),
    };
    return builder;
  });

  return { handlerTx, triggered };
};

type MockTelegramApi = {
  call: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  sendChatAction: ReturnType<typeof vi.fn>;
};

const buildMockApi = (overrides: Partial<MockTelegramApi> = {}): MockTelegramApi => ({
  call: vi.fn(async () => ({ ok: true, result: {} })),
  sendMessage: vi.fn(),
  editMessageText: vi.fn(),
  sendChatAction: vi.fn(async () => ({ ok: true, result: true })),
  ...overrides,
});

describe("command-handler-api", () => {
  test("batches send/edit enqueues into a single handlerTx", async () => {
    const { handlerTx, triggered } = buildHandlerTx();
    const api = buildMockApi();

    const { api: handlerApi, flush } = createCommandHandlerApi(
      api as unknown as TelegramApi,
      handlerTx as unknown as HookHandlerTx,
    );

    await handlerApi.sendMessage({ chat_id: 1, text: "hi" });
    await handlerApi.editMessageText({ chat_id: 1, message_id: 2, text: "edit" });

    expect(handlerTx).not.toHaveBeenCalled();
    expect(triggered).toHaveLength(0);

    await flush();

    expect(handlerTx).toHaveBeenCalledTimes(1);
    expect(triggered).toHaveLength(2);
    expect(triggered.map((entry) => entry.hookName)).toEqual([
      "internalOutgoingMessage",
      "internalOutgoingMessage",
    ]);
    const actions = triggered.map((entry) => {
      const payload = entry.payload;
      if (!payload || typeof payload !== "object" || !("action" in payload)) {
        return undefined;
      }
      return (payload as { action: string }).action;
    });
    expect(actions).toEqual(["sendMessage", "editMessageText"]);
  });

  test("flush is a noop when queue is empty", async () => {
    const { handlerTx } = buildHandlerTx();
    const api = buildMockApi();

    const { flush } = createCommandHandlerApi(
      api as unknown as TelegramApi,
      handlerTx as unknown as HookHandlerTx,
    );

    await flush();
    expect(handlerTx).not.toHaveBeenCalled();
  });

  test("call routes non-send/edit methods directly", async () => {
    const { handlerTx, triggered } = buildHandlerTx();
    const api = buildMockApi({
      call: vi.fn(async () => ({ ok: true, result: { ok: true } })),
    });

    const { api: handlerApi, flush } = createCommandHandlerApi(
      api as unknown as TelegramApi,
      handlerTx as unknown as HookHandlerTx,
    );

    const result = await handlerApi.call("getMe", {});
    expect(result).toEqual({ ok: true, result: { ok: true } });
    expect(api.call).toHaveBeenCalledTimes(1);
    expect(handlerTx).not.toHaveBeenCalled();

    await flush();
    expect(handlerTx).not.toHaveBeenCalled();
    expect(triggered).toHaveLength(0);
  });

  test("call routes send/edit methods case-insensitively", async () => {
    const { handlerTx, triggered } = buildHandlerTx();
    const api = buildMockApi();

    const { api: handlerApi, flush } = createCommandHandlerApi(
      api as unknown as TelegramApi,
      handlerTx as unknown as HookHandlerTx,
    );

    const sendResult = await handlerApi.call("sendMessage", { chat_id: 1, text: "hi" });
    const editResult = await handlerApi.call("EDITMESSAGETEXT", {
      chat_id: 1,
      message_id: 2,
      text: "edit",
    });

    expect(sendResult).toEqual({ ok: true, queued: true });
    expect(editResult).toEqual({ ok: true, queued: true });
    expect(api.call).not.toHaveBeenCalled();

    await flush();
    expect(triggered).toHaveLength(2);
  });

  test("sendChatAction passes through without enqueue", async () => {
    const { handlerTx } = buildHandlerTx();
    const api = buildMockApi();

    const { api: handlerApi, flush } = createCommandHandlerApi(
      api as unknown as TelegramApi,
      handlerTx as unknown as HookHandlerTx,
    );

    await handlerApi.sendChatAction({ chat_id: 1, action: "typing" });
    expect(api.sendChatAction).toHaveBeenCalledTimes(1);

    await flush();
    expect(handlerTx).not.toHaveBeenCalled();
  });
});
