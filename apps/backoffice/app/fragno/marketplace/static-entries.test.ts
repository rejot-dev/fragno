import { describe, expect, test } from "vitest";

import {
  getNextStaticMarketplaceEntry,
  getStaticMarketplaceEntry,
  listStaticMarketplaceEntries,
  marketplaceManifestSchema,
  STATIC_MARKETPLACE_ENTRIES,
} from "./static-entries";

describe("static Marketplace entries", () => {
  test("rejects duplicate parsed manifest versions", () => {
    expect(() =>
      marketplaceManifestSchema.parse({
        owner: { scope: { kind: "system" }, publisherName: "Fragno" },
        slug: "duplicate-version-test",
        metadata: {
          name: "Duplicate version test",
          summary: "Reject duplicate semantic versions in static manifests.",
          description:
            "Static Marketplace manifests must identify each semantic version exactly once.",
          category: "developer-tools",
          tags: [],
        },
        versions: ["1.0.0", " 1.0.0 "],
      }),
    ).toThrow("Marketplace manifest versions must be unique.");
  });

  test("loads listings and version artifacts from disk", () => {
    expect({
      listings: STATIC_MARKETPLACE_ENTRIES,
      versions: listStaticMarketplaceEntries(),
    }).toMatchInlineSnapshot(`
      {
        "listings": [
          {
            "metadata": {
              "category": "communication",
              "description": "A small durable workflow for verifying that Telegram events, workflow sleeps, and delayed replies are configured correctly.",
              "name": "Telegram test command",
              "summary": "Send a delayed Telegram reply when a chat receives the /test command.",
              "tags": [
                "telegram",
                "testing",
                "workflow",
              ],
            },
            "owner": {
              "publisherName": "Fragno",
              "scope": {
                "kind": "system",
              },
            },
            "rootFiles": {
              "README.md": "# Telegram test command

      This Marketplace item installs a durable workflow that responds to the \`/test\` Telegram command
      after a three-second delay. Version 1.3.0 adds an installation interface for choosing the reply and
      stores that message in the selected automation scope.
      ",
            },
            "slug": "telegram-test-command",
            "versions": [
              {
                "files": {
                  "automations/telegram-test-command.workflow.js": "defineWorkflow({ name: "telegram-test-command" }, async (event, step) => {
        const automationEvent = event;
        const text = automationEvent.payload.text;
        const chatId = automationEvent.payload.chatId;

        if (text !== "/test") {
          return { skipped: true, reason: "not-test-command" };
        }

        await step.sleep("wait 3 seconds", "3 seconds");

        await step.do("send delayed test reply", async () => {
          await telegram.sendMessage({
            chatId,
            text: "Delayed /test reply after 3 seconds.",
            parseMode: "Markdown",
          });
        });

        return { sent: true };
      });
      ",
                },
                "version": "1.0.0",
              },
              {
                "files": {
                  ".marketplace/install.workflow.js": "defineWorkflow({ name: "install-telegram-test-command" }, async () => {
        throw new Error("Intentional Telegram test command installer failure.");
      });
      ",
                  "automations/telegram-test-command.workflow.js": "defineWorkflow({ name: "telegram-test-command" }, async (event, step) => {
        const automationEvent = event;
        const text = automationEvent.payload.text;
        const chatId = automationEvent.payload.chatId;

        if (text !== "/test") {
          return { skipped: true, reason: "not-test-command" };
        }

        await step.sleep("wait 3 seconds", "3 seconds");

        await step.do("send delayed test reply", async () => {
          await telegram.sendMessage({
            chatId,
            text: "Telegram integration verified after a 3 second delay.",
            parseMode: "Markdown",
          });
        });

        return { sent: true };
      });
      ",
                },
                "version": "1.1.0",
              },
              {
                "files": {
                  ".marketplace/install.workflow.js": "/// <reference path="/static/codemode/workflow-authoring.d.ts" />

      defineWorkflow(
        { name: "install-telegram-test-command" },
        async (/** @type {WorkflowEvent<any>} */ event, step) => {
          const workflowScriptPath =
            event.payload.installedFiles["automations/telegram-test-command.workflow.js"];
          if (!workflowScriptPath) {
            throw new Error("Telegram test command workflow was not installed.");
          }

          await step.do("ensure Telegram /test route", async () => {
            const desired = {
              id: "telegram-test-command",
              name: "Telegram /test command",
              trigger: {
                kind: "event",
                source: "telegram",
                eventType: "message.received",
                matcher: { path: "$.payload.text", op: "eq", value: "/test" },
              },
              priority: 110,
              action: {
                kind: "start_workflow",
                authority: { kind: "organization-automation" },
                workflowScriptPath,
                instanceIdTemplate: "telegram-test-\${event.id}",
              },
              managedBy: {
                kind: "marketplace",
                listingId: event.payload.listingId,
                resourceKey: "telegram-test-command-route",
                version: event.payload.version,
              },
            };
            // @ts-expect-error -- router is injected into the workflow runtime.
            const existing = await router.get({ id: desired.id });
            if (!existing) {
              // @ts-expect-error -- router is injected into the workflow runtime.
              return await router.create({ ...desired, enabled: true });
            }

            const managedBy = existing.metadata?.managedBy;
            const ownedByThisInstallation =
              managedBy?.kind === "marketplace" &&
              managedBy.listingId === event.payload.listingId &&
              managedBy.resourceKey === desired.managedBy.resourceKey;
            if (!ownedByThisInstallation) {
              throw new Error(
                "Automation route 'telegram-test-command' already exists and is not managed by this Marketplace installation.",
              );
            }

            // @ts-expect-error -- router is injected into the workflow runtime.
            return await router.update({
              ...desired,
              enabled: existing.enabled,
            });
          });
        },
      );
      ",
                  "automations/telegram-test-command.workflow.js": "defineWorkflow({ name: "telegram-test-command" }, async (event, step) => {
        const automationEvent = event;
        const text = automationEvent.payload.text;
        const chatId = automationEvent.payload.chatId;

        if (text !== "/test") {
          return { skipped: true, reason: "not-test-command" };
        }

        await step.sleep("wait 3 seconds", "3 seconds");

        await step.do("send delayed test reply", async () => {
          await telegram.sendMessage({
            chatId,
            text: "Telegram integration verified after a 3 second delay.",
            parseMode: "Markdown",
          });
        });

        return { sent: true };
      });
      ",
                },
                "version": "1.2.1",
              },
              {
                "files": {
                  ".marketplace/install.workflow.js": "/// <reference path="/static/codemode/workflow-authoring.d.ts" />

      defineWorkflow(
        { name: "install-telegram-test-command" },
        async (/** @type {WorkflowEvent<any>} */ event, step) => {
          const workflowScriptPath =
            event.payload.installedFiles["automations/telegram-test-command.workflow.js"];
          if (!workflowScriptPath) {
            throw new Error("Telegram test command workflow was not installed.");
          }

          const existingMessage = await step.do("load current test message", async () => {
            // @ts-expect-error -- store is injected into the workflow runtime.
            const storedMessage = await store.get({
              key: "marketplace/telegram-test-command/message",
            });
            return storedMessage?.value ?? "Telegram integration verified after a 3 second delay.";
          });

          await step.do("request test message", async () => ({
            $ui: {
              version: 1,
              state: { response: { message: existingMessage } },
              spec: {
                root: "form",
                elements: {
                  form: {
                    type: "Stack",
                    props: { gap: "md" },
                    children: ["heading", "description", "message", "submit"],
                  },
                  heading: {
                    type: "Heading",
                    props: { text: "Configure the Telegram test reply", level: 3 },
                    children: [],
                  },
                  description: {
                    type: "Text",
                    props: {
                      text: "Choose the message that Telegram should send after receiving /test.",
                      tone: "muted",
                    },
                    children: [],
                  },
                  message: {
                    type: "TextArea",
                    props: {
                      label: "Test message",
                      value: { $bindState: "/response/message" },
                      description: "This message is stored in the selected automation scope.",
                      required: true,
                      rows: 4,
                    },
                    children: [],
                  },
                  submit: {
                    type: "WorkflowEventButton",
                    props: {
                      label: "Save test message",
                      eventType: "telegram-test-command.message-configured",
                      payload: { $state: "/response" },
                      variant: "primary",
                    },
                    children: [],
                  },
                },
              },
            },
          }));

          const configuration = await step.waitForEvent("wait for test message", {
            type: "telegram-test-command.message-configured",
          });
          const configuredMessage = /** @type {{message?: unknown}} */ (configuration.payload).message;
          if (typeof configuredMessage !== "string" || !configuredMessage.trim()) {
            throw new Error("Telegram test message must be a non-empty string.");
          }

          await step.do("store test message", async () => {
            // @ts-expect-error -- store is injected into the workflow runtime.
            return await store.set({
              key: "marketplace/telegram-test-command/message",
              value: configuredMessage.trim(),
              description: "Reply sent by the Marketplace-managed Telegram /test command.",
              category: ["marketplace", "telegram", "configuration"],
            });
          });

          await step.do("ensure Telegram /test route", async () => {
            const desired = {
              id: "telegram-test-command",
              name: "Telegram /test command",
              trigger: {
                kind: "event",
                source: "telegram",
                eventType: "message.received",
                matcher: { path: "$.payload.text", op: "eq", value: "/test" },
              },
              priority: 110,
              action: {
                kind: "start_workflow",
                authority: { kind: "organization-automation" },
                workflowScriptPath,
                instanceIdTemplate: "telegram-test-\${event.id}",
              },
              managedBy: {
                kind: "marketplace",
                listingId: event.payload.listingId,
                resourceKey: "telegram-test-command-route",
                version: event.payload.version,
              },
            };
            // @ts-expect-error -- router is injected into the workflow runtime.
            const existing = await router.get({ id: desired.id });
            if (!existing) {
              // @ts-expect-error -- router is injected into the workflow runtime.
              return await router.create({ ...desired, enabled: true });
            }

            const managedBy = existing.metadata?.managedBy;
            const ownedByThisInstallation =
              managedBy?.kind === "marketplace" &&
              managedBy.listingId === event.payload.listingId &&
              managedBy.resourceKey === desired.managedBy.resourceKey;
            if (!ownedByThisInstallation) {
              throw new Error(
                "Automation route 'telegram-test-command' already exists and is not managed by this Marketplace installation.",
              );
            }

            // @ts-expect-error -- router is injected into the workflow runtime.
            return await router.update({
              ...desired,
              enabled: existing.enabled,
            });
          });
        },
      );
      ",
                  "automations/telegram-test-command.workflow.js": "defineWorkflow({ name: "telegram-test-command" }, async (event, step) => {
        const automationEvent = event;
        const text = automationEvent.payload.text;
        const chatId = automationEvent.payload.chatId;

        if (text !== "/test") {
          return { skipped: true, reason: "not-test-command" };
        }

        await step.sleep("wait 3 seconds", "3 seconds");

        const configuredMessage = await step.do("load configured test reply", async () => {
          const storedMessage = await store.get({
            key: "marketplace/telegram-test-command/message",
          });
          return storedMessage?.value ?? "Telegram integration verified after a 3 second delay.";
        });

        await step.do("send delayed test reply", async () => {
          await telegram.sendMessage({
            chatId,
            text: configuredMessage,
            parseMode: "Markdown",
          });
        });

        return { sent: true };
      });
      ",
                },
                "version": "1.3.0",
              },
            ],
          },
        ],
        "versions": [
          {
            "files": {
              "automations/telegram-test-command.workflow.js": "defineWorkflow({ name: "telegram-test-command" }, async (event, step) => {
        const automationEvent = event;
        const text = automationEvent.payload.text;
        const chatId = automationEvent.payload.chatId;

        if (text !== "/test") {
          return { skipped: true, reason: "not-test-command" };
        }

        await step.sleep("wait 3 seconds", "3 seconds");

        await step.do("send delayed test reply", async () => {
          await telegram.sendMessage({
            chatId,
            text: "Delayed /test reply after 3 seconds.",
            parseMode: "Markdown",
          });
        });

        return { sent: true };
      });
      ",
            },
            "metadata": {
              "category": "communication",
              "description": "A small durable workflow for verifying that Telegram events, workflow sleeps, and delayed replies are configured correctly.",
              "name": "Telegram test command",
              "summary": "Send a delayed Telegram reply when a chat receives the /test command.",
              "tags": [
                "telegram",
                "testing",
                "workflow",
              ],
            },
            "owner": {
              "publisherName": "Fragno",
              "scope": {
                "kind": "system",
              },
            },
            "rootFiles": {
              "README.md": "# Telegram test command

      This Marketplace item installs a durable workflow that responds to the \`/test\` Telegram command
      after a three-second delay. Version 1.3.0 adds an installation interface for choosing the reply and
      stores that message in the selected automation scope.
      ",
            },
            "slug": "telegram-test-command",
            "version": "1.0.0",
          },
          {
            "files": {
              ".marketplace/install.workflow.js": "defineWorkflow({ name: "install-telegram-test-command" }, async () => {
        throw new Error("Intentional Telegram test command installer failure.");
      });
      ",
              "automations/telegram-test-command.workflow.js": "defineWorkflow({ name: "telegram-test-command" }, async (event, step) => {
        const automationEvent = event;
        const text = automationEvent.payload.text;
        const chatId = automationEvent.payload.chatId;

        if (text !== "/test") {
          return { skipped: true, reason: "not-test-command" };
        }

        await step.sleep("wait 3 seconds", "3 seconds");

        await step.do("send delayed test reply", async () => {
          await telegram.sendMessage({
            chatId,
            text: "Telegram integration verified after a 3 second delay.",
            parseMode: "Markdown",
          });
        });

        return { sent: true };
      });
      ",
            },
            "metadata": {
              "category": "communication",
              "description": "A small durable workflow for verifying that Telegram events, workflow sleeps, and delayed replies are configured correctly.",
              "name": "Telegram test command",
              "summary": "Send a delayed Telegram reply when a chat receives the /test command.",
              "tags": [
                "telegram",
                "testing",
                "workflow",
              ],
            },
            "owner": {
              "publisherName": "Fragno",
              "scope": {
                "kind": "system",
              },
            },
            "rootFiles": {
              "README.md": "# Telegram test command

      This Marketplace item installs a durable workflow that responds to the \`/test\` Telegram command
      after a three-second delay. Version 1.3.0 adds an installation interface for choosing the reply and
      stores that message in the selected automation scope.
      ",
            },
            "slug": "telegram-test-command",
            "version": "1.1.0",
          },
          {
            "files": {
              ".marketplace/install.workflow.js": "/// <reference path="/static/codemode/workflow-authoring.d.ts" />

      defineWorkflow(
        { name: "install-telegram-test-command" },
        async (/** @type {WorkflowEvent<any>} */ event, step) => {
          const workflowScriptPath =
            event.payload.installedFiles["automations/telegram-test-command.workflow.js"];
          if (!workflowScriptPath) {
            throw new Error("Telegram test command workflow was not installed.");
          }

          await step.do("ensure Telegram /test route", async () => {
            const desired = {
              id: "telegram-test-command",
              name: "Telegram /test command",
              trigger: {
                kind: "event",
                source: "telegram",
                eventType: "message.received",
                matcher: { path: "$.payload.text", op: "eq", value: "/test" },
              },
              priority: 110,
              action: {
                kind: "start_workflow",
                authority: { kind: "organization-automation" },
                workflowScriptPath,
                instanceIdTemplate: "telegram-test-\${event.id}",
              },
              managedBy: {
                kind: "marketplace",
                listingId: event.payload.listingId,
                resourceKey: "telegram-test-command-route",
                version: event.payload.version,
              },
            };
            // @ts-expect-error -- router is injected into the workflow runtime.
            const existing = await router.get({ id: desired.id });
            if (!existing) {
              // @ts-expect-error -- router is injected into the workflow runtime.
              return await router.create({ ...desired, enabled: true });
            }

            const managedBy = existing.metadata?.managedBy;
            const ownedByThisInstallation =
              managedBy?.kind === "marketplace" &&
              managedBy.listingId === event.payload.listingId &&
              managedBy.resourceKey === desired.managedBy.resourceKey;
            if (!ownedByThisInstallation) {
              throw new Error(
                "Automation route 'telegram-test-command' already exists and is not managed by this Marketplace installation.",
              );
            }

            // @ts-expect-error -- router is injected into the workflow runtime.
            return await router.update({
              ...desired,
              enabled: existing.enabled,
            });
          });
        },
      );
      ",
              "automations/telegram-test-command.workflow.js": "defineWorkflow({ name: "telegram-test-command" }, async (event, step) => {
        const automationEvent = event;
        const text = automationEvent.payload.text;
        const chatId = automationEvent.payload.chatId;

        if (text !== "/test") {
          return { skipped: true, reason: "not-test-command" };
        }

        await step.sleep("wait 3 seconds", "3 seconds");

        await step.do("send delayed test reply", async () => {
          await telegram.sendMessage({
            chatId,
            text: "Telegram integration verified after a 3 second delay.",
            parseMode: "Markdown",
          });
        });

        return { sent: true };
      });
      ",
            },
            "metadata": {
              "category": "communication",
              "description": "A small durable workflow for verifying that Telegram events, workflow sleeps, and delayed replies are configured correctly.",
              "name": "Telegram test command",
              "summary": "Send a delayed Telegram reply when a chat receives the /test command.",
              "tags": [
                "telegram",
                "testing",
                "workflow",
              ],
            },
            "owner": {
              "publisherName": "Fragno",
              "scope": {
                "kind": "system",
              },
            },
            "rootFiles": {
              "README.md": "# Telegram test command

      This Marketplace item installs a durable workflow that responds to the \`/test\` Telegram command
      after a three-second delay. Version 1.3.0 adds an installation interface for choosing the reply and
      stores that message in the selected automation scope.
      ",
            },
            "slug": "telegram-test-command",
            "version": "1.2.1",
          },
          {
            "files": {
              ".marketplace/install.workflow.js": "/// <reference path="/static/codemode/workflow-authoring.d.ts" />

      defineWorkflow(
        { name: "install-telegram-test-command" },
        async (/** @type {WorkflowEvent<any>} */ event, step) => {
          const workflowScriptPath =
            event.payload.installedFiles["automations/telegram-test-command.workflow.js"];
          if (!workflowScriptPath) {
            throw new Error("Telegram test command workflow was not installed.");
          }

          const existingMessage = await step.do("load current test message", async () => {
            // @ts-expect-error -- store is injected into the workflow runtime.
            const storedMessage = await store.get({
              key: "marketplace/telegram-test-command/message",
            });
            return storedMessage?.value ?? "Telegram integration verified after a 3 second delay.";
          });

          await step.do("request test message", async () => ({
            $ui: {
              version: 1,
              state: { response: { message: existingMessage } },
              spec: {
                root: "form",
                elements: {
                  form: {
                    type: "Stack",
                    props: { gap: "md" },
                    children: ["heading", "description", "message", "submit"],
                  },
                  heading: {
                    type: "Heading",
                    props: { text: "Configure the Telegram test reply", level: 3 },
                    children: [],
                  },
                  description: {
                    type: "Text",
                    props: {
                      text: "Choose the message that Telegram should send after receiving /test.",
                      tone: "muted",
                    },
                    children: [],
                  },
                  message: {
                    type: "TextArea",
                    props: {
                      label: "Test message",
                      value: { $bindState: "/response/message" },
                      description: "This message is stored in the selected automation scope.",
                      required: true,
                      rows: 4,
                    },
                    children: [],
                  },
                  submit: {
                    type: "WorkflowEventButton",
                    props: {
                      label: "Save test message",
                      eventType: "telegram-test-command.message-configured",
                      payload: { $state: "/response" },
                      variant: "primary",
                    },
                    children: [],
                  },
                },
              },
            },
          }));

          const configuration = await step.waitForEvent("wait for test message", {
            type: "telegram-test-command.message-configured",
          });
          const configuredMessage = /** @type {{message?: unknown}} */ (configuration.payload).message;
          if (typeof configuredMessage !== "string" || !configuredMessage.trim()) {
            throw new Error("Telegram test message must be a non-empty string.");
          }

          await step.do("store test message", async () => {
            // @ts-expect-error -- store is injected into the workflow runtime.
            return await store.set({
              key: "marketplace/telegram-test-command/message",
              value: configuredMessage.trim(),
              description: "Reply sent by the Marketplace-managed Telegram /test command.",
              category: ["marketplace", "telegram", "configuration"],
            });
          });

          await step.do("ensure Telegram /test route", async () => {
            const desired = {
              id: "telegram-test-command",
              name: "Telegram /test command",
              trigger: {
                kind: "event",
                source: "telegram",
                eventType: "message.received",
                matcher: { path: "$.payload.text", op: "eq", value: "/test" },
              },
              priority: 110,
              action: {
                kind: "start_workflow",
                authority: { kind: "organization-automation" },
                workflowScriptPath,
                instanceIdTemplate: "telegram-test-\${event.id}",
              },
              managedBy: {
                kind: "marketplace",
                listingId: event.payload.listingId,
                resourceKey: "telegram-test-command-route",
                version: event.payload.version,
              },
            };
            // @ts-expect-error -- router is injected into the workflow runtime.
            const existing = await router.get({ id: desired.id });
            if (!existing) {
              // @ts-expect-error -- router is injected into the workflow runtime.
              return await router.create({ ...desired, enabled: true });
            }

            const managedBy = existing.metadata?.managedBy;
            const ownedByThisInstallation =
              managedBy?.kind === "marketplace" &&
              managedBy.listingId === event.payload.listingId &&
              managedBy.resourceKey === desired.managedBy.resourceKey;
            if (!ownedByThisInstallation) {
              throw new Error(
                "Automation route 'telegram-test-command' already exists and is not managed by this Marketplace installation.",
              );
            }

            // @ts-expect-error -- router is injected into the workflow runtime.
            return await router.update({
              ...desired,
              enabled: existing.enabled,
            });
          });
        },
      );
      ",
              "automations/telegram-test-command.workflow.js": "defineWorkflow({ name: "telegram-test-command" }, async (event, step) => {
        const automationEvent = event;
        const text = automationEvent.payload.text;
        const chatId = automationEvent.payload.chatId;

        if (text !== "/test") {
          return { skipped: true, reason: "not-test-command" };
        }

        await step.sleep("wait 3 seconds", "3 seconds");

        const configuredMessage = await step.do("load configured test reply", async () => {
          const storedMessage = await store.get({
            key: "marketplace/telegram-test-command/message",
          });
          return storedMessage?.value ?? "Telegram integration verified after a 3 second delay.";
        });

        await step.do("send delayed test reply", async () => {
          await telegram.sendMessage({
            chatId,
            text: configuredMessage,
            parseMode: "Markdown",
          });
        });

        return { sent: true };
      });
      ",
            },
            "metadata": {
              "category": "communication",
              "description": "A small durable workflow for verifying that Telegram events, workflow sleeps, and delayed replies are configured correctly.",
              "name": "Telegram test command",
              "summary": "Send a delayed Telegram reply when a chat receives the /test command.",
              "tags": [
                "telegram",
                "testing",
                "workflow",
              ],
            },
            "owner": {
              "publisherName": "Fragno",
              "scope": {
                "kind": "system",
              },
            },
            "rootFiles": {
              "README.md": "# Telegram test command

      This Marketplace item installs a durable workflow that responds to the \`/test\` Telegram command
      after a three-second delay. Version 1.3.0 adds an installation interface for choosing the reply and
      stores that message in the selected automation scope.
      ",
            },
            "slug": "telegram-test-command",
            "version": "1.3.0",
          },
        ],
      }
    `);
  });

  test("looks up exact and subsequent versions", () => {
    expect({
      exact: getStaticMarketplaceEntry({
        slug: "telegram-test-command",
        version: "1.0.0",
      }),
      next: getNextStaticMarketplaceEntry({
        slug: "telegram-test-command",
        version: "1.0.0",
      }),
      afterLatest: getNextStaticMarketplaceEntry({
        slug: "telegram-test-command",
        version: "1.1.0",
      }),
      missing: getStaticMarketplaceEntry({
        slug: "missing-entry",
        version: "1.0.0",
      }),
    }).toMatchInlineSnapshot(`
      {
        "afterLatest": {
          "files": {
            ".marketplace/install.workflow.js": "/// <reference path="/static/codemode/workflow-authoring.d.ts" />

      defineWorkflow(
        { name: "install-telegram-test-command" },
        async (/** @type {WorkflowEvent<any>} */ event, step) => {
          const workflowScriptPath =
            event.payload.installedFiles["automations/telegram-test-command.workflow.js"];
          if (!workflowScriptPath) {
            throw new Error("Telegram test command workflow was not installed.");
          }

          await step.do("ensure Telegram /test route", async () => {
            const desired = {
              id: "telegram-test-command",
              name: "Telegram /test command",
              trigger: {
                kind: "event",
                source: "telegram",
                eventType: "message.received",
                matcher: { path: "$.payload.text", op: "eq", value: "/test" },
              },
              priority: 110,
              action: {
                kind: "start_workflow",
                authority: { kind: "organization-automation" },
                workflowScriptPath,
                instanceIdTemplate: "telegram-test-\${event.id}",
              },
              managedBy: {
                kind: "marketplace",
                listingId: event.payload.listingId,
                resourceKey: "telegram-test-command-route",
                version: event.payload.version,
              },
            };
            // @ts-expect-error -- router is injected into the workflow runtime.
            const existing = await router.get({ id: desired.id });
            if (!existing) {
              // @ts-expect-error -- router is injected into the workflow runtime.
              return await router.create({ ...desired, enabled: true });
            }

            const managedBy = existing.metadata?.managedBy;
            const ownedByThisInstallation =
              managedBy?.kind === "marketplace" &&
              managedBy.listingId === event.payload.listingId &&
              managedBy.resourceKey === desired.managedBy.resourceKey;
            if (!ownedByThisInstallation) {
              throw new Error(
                "Automation route 'telegram-test-command' already exists and is not managed by this Marketplace installation.",
              );
            }

            // @ts-expect-error -- router is injected into the workflow runtime.
            return await router.update({
              ...desired,
              enabled: existing.enabled,
            });
          });
        },
      );
      ",
            "automations/telegram-test-command.workflow.js": "defineWorkflow({ name: "telegram-test-command" }, async (event, step) => {
        const automationEvent = event;
        const text = automationEvent.payload.text;
        const chatId = automationEvent.payload.chatId;

        if (text !== "/test") {
          return { skipped: true, reason: "not-test-command" };
        }

        await step.sleep("wait 3 seconds", "3 seconds");

        await step.do("send delayed test reply", async () => {
          await telegram.sendMessage({
            chatId,
            text: "Telegram integration verified after a 3 second delay.",
            parseMode: "Markdown",
          });
        });

        return { sent: true };
      });
      ",
          },
          "metadata": {
            "category": "communication",
            "description": "A small durable workflow for verifying that Telegram events, workflow sleeps, and delayed replies are configured correctly.",
            "name": "Telegram test command",
            "summary": "Send a delayed Telegram reply when a chat receives the /test command.",
            "tags": [
              "telegram",
              "testing",
              "workflow",
            ],
          },
          "owner": {
            "publisherName": "Fragno",
            "scope": {
              "kind": "system",
            },
          },
          "rootFiles": {
            "README.md": "# Telegram test command

      This Marketplace item installs a durable workflow that responds to the \`/test\` Telegram command
      after a three-second delay. Version 1.3.0 adds an installation interface for choosing the reply and
      stores that message in the selected automation scope.
      ",
          },
          "slug": "telegram-test-command",
          "version": "1.2.1",
        },
        "exact": {
          "files": {
            "automations/telegram-test-command.workflow.js": "defineWorkflow({ name: "telegram-test-command" }, async (event, step) => {
        const automationEvent = event;
        const text = automationEvent.payload.text;
        const chatId = automationEvent.payload.chatId;

        if (text !== "/test") {
          return { skipped: true, reason: "not-test-command" };
        }

        await step.sleep("wait 3 seconds", "3 seconds");

        await step.do("send delayed test reply", async () => {
          await telegram.sendMessage({
            chatId,
            text: "Delayed /test reply after 3 seconds.",
            parseMode: "Markdown",
          });
        });

        return { sent: true };
      });
      ",
          },
          "metadata": {
            "category": "communication",
            "description": "A small durable workflow for verifying that Telegram events, workflow sleeps, and delayed replies are configured correctly.",
            "name": "Telegram test command",
            "summary": "Send a delayed Telegram reply when a chat receives the /test command.",
            "tags": [
              "telegram",
              "testing",
              "workflow",
            ],
          },
          "owner": {
            "publisherName": "Fragno",
            "scope": {
              "kind": "system",
            },
          },
          "rootFiles": {
            "README.md": "# Telegram test command

      This Marketplace item installs a durable workflow that responds to the \`/test\` Telegram command
      after a three-second delay. Version 1.3.0 adds an installation interface for choosing the reply and
      stores that message in the selected automation scope.
      ",
          },
          "slug": "telegram-test-command",
          "version": "1.0.0",
        },
        "missing": null,
        "next": {
          "files": {
            ".marketplace/install.workflow.js": "defineWorkflow({ name: "install-telegram-test-command" }, async () => {
        throw new Error("Intentional Telegram test command installer failure.");
      });
      ",
            "automations/telegram-test-command.workflow.js": "defineWorkflow({ name: "telegram-test-command" }, async (event, step) => {
        const automationEvent = event;
        const text = automationEvent.payload.text;
        const chatId = automationEvent.payload.chatId;

        if (text !== "/test") {
          return { skipped: true, reason: "not-test-command" };
        }

        await step.sleep("wait 3 seconds", "3 seconds");

        await step.do("send delayed test reply", async () => {
          await telegram.sendMessage({
            chatId,
            text: "Telegram integration verified after a 3 second delay.",
            parseMode: "Markdown",
          });
        });

        return { sent: true };
      });
      ",
          },
          "metadata": {
            "category": "communication",
            "description": "A small durable workflow for verifying that Telegram events, workflow sleeps, and delayed replies are configured correctly.",
            "name": "Telegram test command",
            "summary": "Send a delayed Telegram reply when a chat receives the /test command.",
            "tags": [
              "telegram",
              "testing",
              "workflow",
            ],
          },
          "owner": {
            "publisherName": "Fragno",
            "scope": {
              "kind": "system",
            },
          },
          "rootFiles": {
            "README.md": "# Telegram test command

      This Marketplace item installs a durable workflow that responds to the \`/test\` Telegram command
      after a three-second delay. Version 1.3.0 adds an installation interface for choosing the reply and
      stores that message in the selected automation scope.
      ",
          },
          "slug": "telegram-test-command",
          "version": "1.1.0",
        },
      }
    `);
  });
});
