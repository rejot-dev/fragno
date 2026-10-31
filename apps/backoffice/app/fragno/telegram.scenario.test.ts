import { assert, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";

import { ApiObject } from "../../workers/api-object";
import { AuthObject } from "../../workers/auth-object";
import { AutomationsObject } from "../../workers/automations-object";
import { BillingObject } from "../../workers/billing-object";
import { CodemodeObject } from "../../workers/codemode-object";
import { FormsObject } from "../../workers/forms-object";
import { GitHubObject } from "../../workers/github-object";
import { McpObject } from "../../workers/mcp-object";
import { OtpObject } from "../../workers/otp-object";
import { ResendObject } from "../../workers/resend-object";
import { UploadObject } from "../../workers/upload-object";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "./automation/scenario";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  FORMS: (input) => new FormsObject(input),
  GITHUB: (input) => new GitHubObject(input),
  MCP: (input) => new McpObject(input),
  OTP: (input) => new OtpObject(input),
  RESEND: (input) => new ResendObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const ORG_SCOPE = { kind: "org", orgId: "org-1", jurisdiction: null } as const;
const GROUP_CHAT = { id: -1001234, type: "supergroup", title: "Shared group" } as const;

const groupMessage = ({
  updateId,
  from,
  senderChat = null,
}: {
  updateId: number;
  from: { id: number; is_bot: boolean; first_name: string };
  senderChat?: typeof GROUP_CHAT | null;
}) => ({
  orgId: "org-1",
  update: {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1780000000,
      text: "mutate organization data",
      from,
      ...(senderChat ? { sender_chat: senderChat } : {}),
      chat: GROUP_CHAT,
    },
  },
});

test("a Telegram group message acts as its sender's linked user, never as one linked to the group", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-telegram-identity-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Telegram group senders are the human identities",
        options: { sqliteDataDirectory: directory },
        files: backofficeFiles.workspaceStarter(),
        fakes: ({ fake }) => ({ telegram: fake.telegram() }),
        setup: ({ given }) => [
          given.auth.user({ id: "linked-user", role: "user" }),
          given.auth.organization({ id: "org-1", ownerUserId: "linked-user" }),
          given.organization.exists({ id: "org-1", ownerUserId: "linked-user" }),
          given.telegram.configured({ orgId: "org-1", botUsername: "identitybot" }),
          given.identity.binding({
            orgId: "org-1",
            source: "telegram",
            externalType: "user",
            externalId: "9999",
            userId: "linked-user",
          }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/automations/group-identity.workflow.js",
            content: `export default defineWorkflow({ name: "group-identity" }, async (event, step) => {
          await step.do("write protected entry", async () => {
            await store.set({
              key: "group-message-" + event.actors.initiator.id,
              value: event.payload.chatId + ":" + event.actors.principal.id,
            });
          });
        });`,
          }),
          given.router.route({
            orgId: "org-1",
            id: "group-identity",
            name: "Group identity",
            enabled: true,
            priority: 100,
            trigger: {
              kind: "event",
              source: "telegram",
              eventType: "message.received",
              matcher: { path: "$.payload.text", op: "exists" },
            },
            action: {
              kind: "start_workflow",
              authority: { kind: "linked-user", grants: [BACKOFFICE_PERMISSION.store.modify] },
              workflowScriptPath: "/workspace/automations/group-identity.workflow.js",
              instanceIdTemplate: "group-identity-${event.id}",
            },
          }),
        ],
        steps: ({ when, then }) => [
          when.telegram.webhook(
            groupMessage({
              updateId: 1,
              from: { id: 5555, is_bot: false, first_name: "Unlinked" },
            }),
          ),
          then.store.missing({ orgId: "org-1", key: "group-message-5555" }),
          then.store.missing({ orgId: "org-1", key: `group-message-${GROUP_CHAT.id}` }),

          when.telegram.webhook(
            groupMessage({ updateId: 2, from: { id: 9999, is_bot: false, first_name: "Linked" } }),
          ),
          then.automation.event({
            scope: ORG_SCOPE,
            where: { source: "telegram", eventType: "message.received" },
            expected: {
              payload: { chatId: String(GROUP_CHAT.id), fromUserId: "9999" },
              actors: {
                initiator: {
                  scope: "external",
                  source: "telegram",
                  type: "user",
                  id: "9999",
                  role: "initiator",
                },
                principal: null,
                delegation: [],
              },
            },
          }),
          then.store.entry({
            orgId: "org-1",
            key: "group-message-9999",
            value: `${GROUP_CHAT.id}:linked-user`,
          }),

          // An anonymous admin posts as the group; Telegram names no person behind it.
          when.telegram.webhook(
            groupMessage({
              updateId: 3,
              from: { id: 1087968824, is_bot: true, first_name: "Group" },
              senderChat: GROUP_CHAT,
            }),
          ),
          then.automation.event({
            scope: ORG_SCOPE,
            where: { source: "telegram", eventType: "message.received" },
            expected: {
              payload: { fromUserId: "1087968824" },
              actors: {
                initiator: {
                  scope: "external",
                  source: "telegram",
                  type: "chat",
                  id: String(GROUP_CHAT.id),
                  role: "initiator",
                },
                principal: null,
                delegation: [],
              },
            },
          }),
          then.store.missing({ orgId: "org-1", key: `group-message-${GROUP_CHAT.id}` }),
          then.workflow.noErrored({ orgId: "org-1" }),
          then.assert("a chat cannot claim a human identity", async (ctx) => {
            await expect(
              ctx.runtime.objects.otp.for(ORG_SCOPE).commands.issueIdentityClaim(
                { expiresInMinutes: null },
                {
                  kind: "deferred",
                  scopeRestriction: null,
                  scope: ORG_SCOPE,
                  actors: {
                    initiator: {
                      scope: "external",
                      source: "telegram",
                      type: "chat",
                      id: String(GROUP_CHAT.id),
                      role: "initiator",
                    },
                    principal: null,
                    delegation: [],
                  },
                },
              ),
            ).rejects.toThrow("cannot be linked to a user");
            assert(ctx.fakes.telegram);
            expect(ctx.fakes.telegram.sendMessageCalls).toEqual([]);
          }),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
