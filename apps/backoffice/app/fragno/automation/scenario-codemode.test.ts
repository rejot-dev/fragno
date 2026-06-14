import { describe, test, vi } from "vitest";

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
    actor: null,
  });

  await state.writeFile("/workspace/codemode-output.txt", "codemode wrote this");
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
