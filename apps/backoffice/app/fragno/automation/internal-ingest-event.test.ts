import { describe, test, vi } from "vitest";

import type { AutomationEvent } from "./contracts";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  class MockRpcTarget {}
  class MockWorkerEntrypoint {}

  return {
    DurableObject: MockDurableObject,
    RpcTarget: MockRpcTarget,
    WorkerEntrypoint: MockWorkerEntrypoint,
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { backofficeFiles, defineBackofficeScenario, runBackofficeScenario } from "./scenario";

const telegramMessageEvent = ({
  id,
  text,
  chatId = "1001",
  attachments,
}: {
  id: string;
  text: string | null;
  chatId?: string;
  attachments?: unknown[];
}): AutomationEvent => {
  const actor = {
    scope: "external" as const,
    source: "telegram",
    type: "chat",
    id: chatId,
  };

  return {
    id,
    orgId: "org-1",
    source: "telegram",
    eventType: "message.received",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {
      chatId,
      text,
      ...(attachments ? { attachments } : {}),
    },
    actor,
    actors: [actor],
    subject: { orgId: "org-1" },
  };
};

describe("automation internal ingest scenarios", () => {
  test("does not run the disabled starter Telegram Pi automation script", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "starter Telegram Pi legacy bash script stays disabled",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.store.entry({
            orgId: "org-1",
            key: "telegram/1001",
            value: "user-1",
          }),
        ],

        steps: ({ when, then }) => [
          when.automation.ingestEvent(
            telegramMessageEvent({ id: "starter-telegram-pi-1", text: "/pi" }),
          ),
          when.automation.ingestEvent(
            telegramMessageEvent({ id: "starter-telegram-pi-2", text: "Hello Pi" }),
          ),

          then.telegram.noMessages(),
          then.assert("assert Pi was not called by legacy scripts", (ctx) => {
            const createSessionCalls = ctx.fakes.pi?.createSessionCalls ?? [];
            const runTurnCalls = ctx.fakes.pi?.runTurnCalls ?? [];
            if (createSessionCalls.length !== 0 || runTurnCalls.length !== 0) {
              throw new Error(
                `Expected no Pi calls, got create=${createSessionCalls.length}, turn=${runTurnCalls.length}.`,
              );
            }
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            instanceId: "telegram-pi-starter-telegram-pi-1",
            status: "complete",
            output: { skipped: true, reason: "missing-default-agent" },
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            instanceId: "telegram-pi-starter-telegram-pi-2",
            status: "complete",
            output: { skipped: true, reason: "missing-default-agent" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("lets Telegram-triggered scripts resolve attachment metadata and download binary bytes", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "Telegram attachment automation can read metadata and bytes",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram({
            files: [
              {
                fileId: "telegram-file-1",
                fileUniqueId: "unique-telegram-file-1",
                filePath: "voice/attachment.ogg",
                fileSize: 4,
                bytes: new Uint8Array([0, 255, 1, 2]),
                contentType: "application/octet-stream",
              },
            ],
          }),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.files({
            orgId: "org-1",
            files: {
              "/workspace/automations/telegram-attachment-download.sh": `file_id="$(jq -r '.payload.attachments[0].fileId // ""' /context/event.json)"
if [ -z "$file_id" ]; then
  echo "Missing attachment fileId in /context/event.json" >&2
  exit 1
fi

telegram.file.get --file-id "$file_id" --print filePath > /workspace/telegram-file-path.txt
telegram.file.download --file-id "$file_id" --output /workspace/telegram-download.bin
`,
            },
          }),
        ],

        steps: ({ when, then }) => [
          when.automation.ingestEvent(
            telegramMessageEvent({
              id: "telegram-attachment-event-1",
              text: null,
              attachments: [{ kind: "voice", fileId: "telegram-file-1" }],
            }),
          ),

          then.assert("assert Telegram file runtime was called", (ctx) => {
            const telegram = ctx.fakes.telegram;
            if (!telegram) {
              throw new Error("Expected fake Telegram runtime.");
            }
            if (
              telegram.getFileCalls.length !== 1 ||
              telegram.getFileCalls[0]?.fileId !== "telegram-file-1"
            ) {
              throw new Error(
                `Expected one getFile call, got ${JSON.stringify(telegram.getFileCalls)}.`,
              );
            }
            if (
              telegram.downloadFileCalls.length !== 1 ||
              telegram.downloadFileCalls[0]?.fileId !== "telegram-file-1"
            ) {
              throw new Error(
                `Expected one downloadFile call, got ${JSON.stringify(telegram.downloadFileCalls)}.`,
              );
            }
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/telegram-file-path.txt",
            text: "voice/attachment.ogg",
          }),
          then.assert("assert Telegram file bytes were written", async (ctx) => {
            const bytes = await ctx.files
              .forOrg("org-1")
              .readFileBuffer("/workspace/telegram-download.bin");
            const expected = [0, 255, 1, 2];
            if (JSON.stringify([...bytes]) !== JSON.stringify(expected)) {
              throw new Error(`Expected downloaded bytes ${expected}, got ${[...bytes]}.`);
            }
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("runs custom static starter automation files in tests", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "custom workspace router overrides starter automation files",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.files({
            orgId: "org-1",
            files: {
              "/workspace/automations/router.cm.js": `async () => {
  await telegram.sendMessage({ chatId: "1001", text: "custom-start" });
};`,
            },
          }),
        ],

        steps: ({ when, then }) => [
          when.automation.ingestEvent(
            telegramMessageEvent({ id: "custom-start-1", text: "/start" }),
          ),

          then.telegram.sentMessage({
            chatId: "1001",
            text: "custom-start",
          }),
          then.workflow.missing({ remoteWorkflowName: "telegram-user-linking" }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });
});
