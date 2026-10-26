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

import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";

import { ApiObject } from "../../../workers/api.do";
import { AppInstallationsObject } from "../../../workers/app-installations.do";
import { AppsObject } from "../../../workers/apps.do";
import { AuthObject } from "../../../workers/auth.do";
import { AutomationsObject } from "../../../workers/automations.do";
import { BillingObject } from "../../../workers/billing.do";
import { CodemodeObject } from "../../../workers/codemode.do";
import { FormsObject } from "../../../workers/forms.do";
import { GitHubWebhookRouterObject } from "../../../workers/github-webhook-router.do";
import { GitHubObject } from "../../../workers/github.do";
import { McpObject } from "../../../workers/mcp.do";
import { OtpObject } from "../../../workers/otp.do";
import { ProjectConnectorObject } from "../../../workers/project-connector.do";
import { ResendObject } from "../../../workers/resend.do";
import { TelegramObject } from "../../../workers/telegram.do";
import { UploadObject } from "../../../workers/upload.do";
import { backofficeFiles, defineBackofficeScenario, runBackofficeScenario } from "./scenario";
const scenarioObjects = {
  API: (input) => new ApiObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  FORMS: (input) => new FormsObject(input),
  MCP: (input) => new McpObject(input),
  OTP: (input) => new OtpObject(input),
  RESEND: (input) => new ResendObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
  GITHUB: (input) => new GitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new GitHubWebhookRouterObject(input),
  PROJECT_CONNECTOR: (input) => new ProjectConnectorObject(input),
} satisfies LocalBackofficeObjects;

describe("Backoffice codemode scenarios", () => {
  test("runs raw codemode through route-backed runtime tools", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "codemode writes automation state",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.codemode.run({
            scope: { kind: "org", orgId: "org-1" },
            label: "write store and workspace state from codemode",
            code: `async () => {
  await store.set({
    key: "foo",
    value: "bar",
  });

  await state.writeFile({
    path: "/workspace/codemode-output.txt",
    content: "codemode wrote this",
  });
}`,
            assertToolCalls: ["store.set"],
          }),

          then.codemode.toolCalls({
            include: ["store.set"],
          }),
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
        objects: scenarioObjects,
        name: "telegram configuration requires a public origin",

        env: {
          DOCS_PUBLIC_BASE_URL: undefined,
          SIGN_UP_INVITATIONS_ENABLED: "false",
        },
        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ then }) => [
          then.assert("Telegram setup fails through the integration", async (ctx) => {
            await expect(
              ctx.runCodemode({
                scope: { kind: "org", orgId: "org-1" },
                label: "configure Telegram without a public origin",
                code: `async () => {
  return await integrations.setup({
    kind: "input",
    connectionId: "backoffice#telegram",
    input: { botToken: "123456:telegram-bot-token", botUsername: null },
  });
}`,
              }),
            ).rejects.toThrow("Telegram public origin is not configured.");
          }),
          then.assert("Telegram stays unconfigured", async (ctx) => {
            const run = await ctx.runCodemode({
              scope: { kind: "org", orgId: "org-1" },
              code: `async () => await integrations.get({ connectionId: "backoffice#telegram" })`,
            });
            expect(run.result).toMatchObject({ configuration: { status: "missing" } });
          }),
        ],
      }),
    );
  });

  test.each(["not-a-url", "/relative", "ftp://example.com"])(
    "leaves Telegram unconfigured when the public origin is %s",
    async (publicOrigin) => {
      await runBackofficeScenario(
        defineBackofficeScenario({
          objects: scenarioObjects,
          name: `telegram configuration rejects public origin ${publicOrigin}`,

          env: {
            DOCS_PUBLIC_BASE_URL: publicOrigin,
            SIGN_UP_INVITATIONS_ENABLED: "false",
          },
          files: backofficeFiles.workspaceStarter(),

          setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

          steps: ({ then }) => [
            then.assert("Telegram configuration rejects the invalid origin", async (ctx) => {
              await expect(
                ctx.runCodemode({
                  scope: { kind: "org", orgId: "org-1" },
                  label: `configure Telegram with public origin ${publicOrigin}`,
                  code: `async () => {
  return await integrations.setup({
    kind: "input",
    connectionId: "backoffice#telegram",
    input: { botToken: "123456:telegram-bot-token", botUsername: null },
  });
}`,
                }),
              ).rejects.toThrow("Telegram public origin must be an absolute HTTP or HTTPS URL.");
            }),
            then.assert("Telegram stays unconfigured", async (ctx) => {
              const run = await ctx.runCodemode({
                scope: { kind: "org", orgId: "org-1" },
                code: `async () => await integrations.get({ connectionId: "backoffice#telegram" })`,
              });
              expect(run.result).toMatchObject({ configuration: { status: "missing" } });
            }),
          ],
        }),
      );
    },
  );

  test("runs codemode through scoped context handles", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "codemode writes state through scoped context handles",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.codemode.run({
            scope: { kind: "org", orgId: "org-1" },
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

  test("exposes user-scoped integrations from scoped codemode handles", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "codemode user scoped context lists integrations without capability setup",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.codemode.run({
            scope: { kind: "org", orgId: "org-1" },
            label: "use user-scoped integrations from codemode",
            code: `async () => await context.user("scenario-user").integrations.list({ cursor: null })`,
            assertToolCalls: ["user:integrations.list"],
          }),

          then.assert("user scoped integrations were available without setup", (ctx) => {
            const result = ctx.codemodeRuns.at(-1)?.result.result as { connections?: unknown[] };
            expect(result.connections).toEqual([]);
          }),
        ],
      }),
    );
  });

  test("lets the explicitly trusted scenario shell arrange another organization", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "trusted scenario codemode writes state through a scoped context",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.organization.exists({ id: "org-2", name: "Grace Labs" }),
        ],

        steps: ({ when, then }) => [
          when.codemode.run({
            scope: { kind: "org", orgId: "org-1" },
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

  test("uses file setup helper for multiple workspace files", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
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
});
