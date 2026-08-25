import { describe, expect, test, vi } from "vitest";

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

describe("Backoffice codemode scenarios", () => {
  test("runs raw codemode through route-backed runtime tools", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "codemode configures upload and writes automation state",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          then.connection.unconfigured({ orgId: "org-1", id: "upload" }),

          when.codemode.run({
            orgId: "org-1",
            label: "configure upload and write store from codemode",
            code: `async () => {
  await connections.configure({
    id: "upload",
    payload: { provider: "database" },
  });

  await store.set({
    key: "foo",
    value: "bar",
  });

  await state.writeFile({
    path: "/workspace/codemode-output.txt",
    content: "codemode wrote this",
  });
  return { ok: true };
}`,
            assertToolCalls: ["connections.configure", "store.set"],
          }),

          then.codemode.toolCalls({
            include: ["connections.configure", "store.set"],
          }),
          then.connection.configured({ orgId: "org-1", id: "upload" }),
          then.store.entry({ orgId: "org-1", key: "foo", value: "bar" }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/codemode-output.txt",
            text: "codemode wrote this",
          }),
          then.files.diff({
            orgId: "org-1",
            include: [{ path: "/workspace/codemode-output.txt", status: "added" }],
          }),
        ],
      }),
    );
  });

  test("leaves Telegram unconfigured when the public origin is missing", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "telegram configuration requires a public origin",

        env: { DOCS_PUBLIC_BASE_URL: undefined },
        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ then }) => [
          then.assert("Telegram configuration fails through the runtime tool", async (ctx) => {
            await expect(
              ctx.runCodemode({
                orgId: "org-1",
                label: "configure Telegram without a public origin",
                code: `async () => {
  return await connections.configure({
    id: "telegram",
    payload: { botToken: "123456:telegram-bot-token" },
  });
}`,
              }),
            ).rejects.toThrow("Telegram public origin is not configured.");
          }),
          then.connection.unconfigured({ orgId: "org-1", id: "telegram" }),
        ],
      }),
    );
  });

  test.each(["not-a-url", "/relative", "ftp://example.com"])(
    "leaves Telegram unconfigured when the public origin is %s",
    async (publicOrigin) => {
      await runBackofficeScenario(
        defineBackofficeScenario({
          name: `telegram configuration rejects public origin ${publicOrigin}`,

          env: { DOCS_PUBLIC_BASE_URL: publicOrigin },
          files: backofficeFiles.workspaceStarter(),

          setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

          steps: ({ then }) => [
            then.assert("Telegram configuration rejects the invalid origin", async (ctx) => {
              await expect(
                ctx.runCodemode({
                  orgId: "org-1",
                  label: `configure Telegram with public origin ${publicOrigin}`,
                  code: `async () => {
  return await connections.configure({
    id: "telegram",
    payload: { botToken: "123456:telegram-bot-token" },
  });
}`,
                }),
              ).rejects.toThrow("Telegram public origin must be an absolute HTTP or HTTPS URL.");
            }),
            then.connection.unconfigured({ orgId: "org-1", id: "telegram" }),
          ],
        }),
      );
    },
  );

  test("generates the Telegram webhook secret during runtime-tool configuration", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "telegram runtime configuration generates its webhook secret",

        files: backofficeFiles.workspaceStarter(),
        fakes: ({ fake }) => ({ telegram: fake.telegram() }),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.codemode.run({
            orgId: "org-1",
            label: "configure Telegram with only user-supplied fields",
            code: `async () => {
  return await connections.configure({
    id: "telegram",
    payload: { botToken: "123456:telegram-bot-token" },
  });
}`,
            assertToolCalls: ["connections.configure"],
          }),
          then.connection.configured({ orgId: "org-1", id: "telegram" }),
          then.assert("Telegram receives a generated webhook secret", (ctx) => {
            expect(ctx.fakes.telegram?.setWebhookCalls).toEqual([
              expect.objectContaining({
                secretToken: expect.stringMatching(/^tg_[a-f0-9]{32}$/),
              }),
            ]);
          }),
        ],
      }),
    );
  });

  test("runs codemode through scoped context handles", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "codemode writes state through scoped context handles",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.codemode.run({
            orgId: "org-1",
            label: "write store entries from scoped codemode context",
            code: `async () => {
  await context.current.store.set({
    key: "scoped/current",
    value: "from-current",
  });

  await context.org("org-1").store.set({
    key: "scoped/org",
    value: "from-org",
  });
}`,
            assertToolCalls: ["current:store.set", "org:store.set"],
          }),

          then.store.entry({ orgId: "org-1", key: "scoped/current", value: "from-current" }),
          then.store.entry({ orgId: "org-1", key: "scoped/org", value: "from-org" }),
          then.codemode.toolCalls({
            include: ["current:store.set", "org:store.set"],
          }),
        ],
      }),
    );
  });

  test("exposes user-scoped MCP connection tools from scoped codemode handles", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "codemode user scoped context uses MCP without capability setup",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.codemode.run({
            orgId: "org-1",
            label: "use user-scoped MCP from codemode",
            code: `async () => await context.user("scenario-user").mcp.listServers()`,
            assertToolCalls: ["user:mcp.listServers"],
          }),

          then.assert("user scoped MCP was available without setup", (ctx) => {
            const result = ctx.codemodeRuns.at(-1)?.result.result as { servers?: unknown[] };
            expect(result.servers).toEqual([]);
          }),
        ],
      }),
    );
  });

  test("lets the explicitly trusted scenario shell arrange another organization", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "trusted scenario codemode writes state through a scoped context",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.organization.exists({ id: "org-2", name: "Grace Labs" }),
        ],

        steps: ({ when, then }) => [
          when.codemode.run({
            orgId: "org-1",
            label: "write store entry into org-2 from trusted scenario codemode",
            code: `async () => {
  await context.org("org-2").store.set({
    key: "scoped/foreign-org",
    value: "from-org-1-codemode",
  });
}`,
          }),
          then.store.entry({
            orgId: "org-2",
            key: "scoped/foreign-org",
            value: "from-org-1-codemode",
          }),
        ],
      }),
    );
  });

  test("uses codemode setup helpers while keeping setup intent explicit", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "codemode setup helpers arrange state through runtime tools",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.codemode.connectionConfigure({
            orgId: "org-1",
            id: "upload",
            payload: { provider: "database" },
          }),
          given.codemode.storeSet({
            orgId: "org-1",
            key: "setup/foo",
            value: "from-codemode",
          }),
          given.codemode.writeFile({
            orgId: "org-1",
            path: "/workspace/setup.txt",
            content: "setup helper wrote this",
          }),
          given.codemode.writeFile({
            orgId: "org-1",
            path: "/workspace/setup.bin",
            content: new Uint8Array([0x62, 0x69, 0x6e, 0x61, 0x72, 0x79]),
          }),
        ],

        steps: ({ then }) => [
          then.connection.configured({ orgId: "org-1", id: "upload" }),
          then.store.entry({
            orgId: "org-1",
            key: "setup/foo",
            value: "from-codemode",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/setup.txt",
            text: "setup helper wrote this",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/setup.bin",
            text: "binary",
          }),
          then.codemode.toolCalls({
            include: ["connections.configure", "store.set"],
          }),
        ],
      }),
    );
  });

  test("uses file setup helper for multiple workspace files", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "file setup helper writes multiple workspace files",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.files({
            orgId: "org-1",
            files: {
              "/workspace/input/alpha.txt": "alpha",
              "/workspace/input/beta.json": JSON.stringify({ beta: true }),
            },
          }),
        ],

        steps: ({ then }) => [
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/input/alpha.txt",
            text: "alpha",
          }),
          then.files.jsonEquals({
            orgId: "org-1",
            path: "/workspace/input/beta.json",
            value: { beta: true },
          }),
          then.files.diff({
            orgId: "org-1",
            include: [
              { path: "/workspace/input/alpha.txt", status: "added" },
              { path: "/workspace/input/beta.json", status: "added" },
            ],
          }),
        ],
      }),
    );
  });

  test("uses a fake Resend runtime through codemode tools", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "fake Resend records codemode replies",

        files: backofficeFiles.workspaceStarter(),

        fakes: ({ fake }) => ({
          resend: fake.resend({
            threads: [
              {
                id: "thread-1",
                subject: "Invoice Update",
                participants: ["customer@example.com", "support@example.com"],
                messages: [
                  {
                    id: "message-1",
                    direction: "inbound",
                    from: "customer@example.com",
                    to: ["support@example.com"],
                    replyTo: ["customer@example.com"],
                    text: "Can you send the invoice again?",
                  },
                ],
              },
            ],
          }),
        }),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.codemode.run({
            orgId: "org-1",
            label: "reply to a Resend thread from codemode",
            code: `async () => {
  await resend.replyToThread({
    threadId: "thread-1",
    body: "Invoice resent.",
  });
}`,
            assertToolCalls: ["resend.threads.reply"],
          }),

          then.resend.repliedToThread({
            threadId: "thread-1",
            body: "Invoice resent.",
          }),
          then.codemode.toolCalls({
            include: ["resend.threads.reply"],
          }),
        ],
      }),
    );
  });
});
