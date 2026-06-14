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

const systemUnrelatedEvent = {
  id: "github:issue.opened:1",
  orgId: "org-1",
  source: "github",
  eventType: "issue.opened",
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload: {
    issueId: "issue-1",
  },
  actor: {
    scope: "external",
    source: "github",
    type: "user",
    id: "octocat",
  },
  actors: [
    {
      scope: "external",
      source: "github",
      type: "user",
      id: "octocat",
    },
  ],
  subject: { orgId: "org-1" },
} satisfies AutomationEvent;

describe("system automation scenarios", () => {
  test("auth organization.created initializes workspace files", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "system organization creation initializes workspace files",

        files: backofficeFiles.systemOnly(),

        setup: ({ given }) => [
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "user-1",
          }),
        ],

        steps: ({ when, then }) => [
          when.auth.organizationCreated({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "user-1",
            ownerEmail: "ada@example.com",
          }),

          then.workflow.instance({
            remoteWorkflowName: "workspace-file-initialization",
            status: "complete",
            output: {
              configured: true,
              id: "upload",
              provider: "database",
            },
          }),

          then.workflow.steps({
            remoteWorkflowName: "workspace-file-initialization",
            include: [
              "configure upload database connection",
              "seed workspace starter files",
              "write codemode dts",
            ],
          }),

          then.files.exists({ orgId: "org-1", path: "/workspace/AGENTS.md" }),
          then.files.exists({
            orgId: "org-1",
            path: "/workspace/automations/router.cm.js",
          }),
          then.files.exists({
            orgId: "org-1",
            path: "/workspace/automations/telegram-user-linking.workflow.js",
          }),
          then.files.exists({
            orgId: "org-1",
            path: "/workspace/automations/telegram-user-pi-linking.workflow.js",
          }),
          then.files.exists({
            orgId: "org-1",
            path: "/workspace/automations/telegram-test-command.workflow.js",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/codemode.d.ts",
            text: "declare",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("unrelated system events do not create system workflow instances", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "system router ignores unrelated automation events",

        files: backofficeFiles.systemOnly(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.automation.ingestEvent(systemUnrelatedEvent),

          then.workflow.missing({
            remoteWorkflowName: "workspace-file-initialization",
          }),
          then.workflow.missing({
            remoteWorkflowName: "codemode-types-refresh",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("workspace-file-initialization skips non-organization-created events", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "workspace initialization skips non-organization-created events",

        files: backofficeFiles.systemOnly(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.workflow.createInstance({
            orgId: "org-1",
            remoteWorkflowName: "workspace-file-initialization",
            instanceId: "workspace-file-initialization-skip",
            params: {
              automationEvent: systemUnrelatedEvent,
              workflowScriptPath: "/system/automations/workspace-file-initialization.workflow.js",
            },
          }),

          then.workflow.instance({
            remoteWorkflowName: "workspace-file-initialization",
            instanceId: "workspace-file-initialization-skip",
            status: "complete",
            output: { skipped: true, reason: "not-organization-created" },
          }),
          then.connection.unconfigured({ orgId: "org-1", id: "upload" }),
          then.files.missing({ orgId: "org-1", path: "/workspace/AGENTS.md" }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("capability.configured writes missing codemode types", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "system capability configuration writes missing codemode types",

        files: backofficeFiles.systemOnly(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
        ],

        steps: ({ when, then }) => [
          when.capability.configured({
            orgId: "org-1",
            source: "telegram",
            capabilityId: "telegram",
            capabilityLabel: "Telegram",
            eventId: "telegram-capability-1",
          }),

          then.workflow.instance({
            instanceId: "codemode-types-refresh-telegram-capability-1",
            status: "complete",
            output: {
              changed: true,
              path: "/workspace/codemode.d.ts",
            },
          }),
          then.workflow.steps({
            instanceId: "codemode-types-refresh-telegram-capability-1",
            include: ["render codemode dts", "read existing codemode dts", "write codemode dts"],
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/codemode.d.ts",
            text: "declare const telegram",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("capability.configured overwrites stale codemode types", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "system capability configuration overwrites stale codemode types",

        files: backofficeFiles.systemOnly(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/codemode.d.ts",
            content: "stale codemode types",
          }),
        ],

        steps: ({ when, then }) => [
          when.capability.configured({
            orgId: "org-1",
            source: "telegram",
            capabilityId: "telegram",
            capabilityLabel: "Telegram",
            eventId: "telegram-capability-stale",
          }),

          then.workflow.instance({
            instanceId: "codemode-types-refresh-telegram-capability-stale",
            status: "complete",
            output: {
              changed: true,
              path: "/workspace/codemode.d.ts",
            },
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/codemode.d.ts",
            text: "Generated by Backoffice system automation",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/codemode.d.ts",
            text: "declare const telegram",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("capability.configured leaves identical codemode types unchanged", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "system capability configuration keeps identical codemode types",

        files: backofficeFiles.systemOnly(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
        ],

        steps: ({ when, then }) => [
          when.capability.configured({
            orgId: "org-1",
            source: "telegram",
            capabilityId: "telegram",
            capabilityLabel: "Telegram",
            eventId: "telegram-capability-first",
          }),

          then.workflow.instance({
            instanceId: "codemode-types-refresh-telegram-capability-first",
            status: "complete",
            output: {
              changed: true,
              path: "/workspace/codemode.d.ts",
            },
          }),

          when.capability.configured({
            orgId: "org-1",
            source: "telegram",
            capabilityId: "telegram",
            capabilityLabel: "Telegram",
            eventId: "telegram-capability-second",
          }),

          then.workflow.instance({
            instanceId: "codemode-types-refresh-telegram-capability-second",
            status: "complete",
            output: {
              changed: false,
              path: "/workspace/codemode.d.ts",
            },
          }),
          then.workflow.steps({
            instanceId: "codemode-types-refresh-telegram-capability-second",
            include: ["render codemode dts", "read existing codemode dts"],
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/codemode.d.ts",
            text: "declare const telegram",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });
});
