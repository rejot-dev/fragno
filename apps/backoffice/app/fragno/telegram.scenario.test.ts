import { assert, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";

import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "./automation/scenario";

test("a shared Telegram conversation cannot inherit its legacy linked user's authority or issue a human claim", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-telegram-identity-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "shared Telegram conversations are not human identities",
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
            externalType: "chat",
            externalId: "-1001234",
            userId: "linked-user",
          }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/automations/group-identity.workflow.js",
            content: `defineWorkflow({ name: "group-identity" }, async (event, step) => {
          await step.do("write protected entry", async () => {
            await store.set({ key: "group-impersonation", value: event.payload.fromUserId });
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
          when.telegram.webhook({
            orgId: "org-1",
            update: {
              update_id: 1,
              message: {
                message_id: 1,
                date: 1780000000,
                text: "mutate organization data",
                from: { id: 9999, is_bot: false, first_name: "Unrelated sender" },
                chat: { id: -1001234, type: "supergroup", title: "Shared group" },
              },
            },
          }),
          then.store.missing({ orgId: "org-1", key: "group-impersonation" }),
          then.workflow.noErrored({ orgId: "org-1" }),
          then.assert(
            "provider provenance remains a shared conversation, not a human identity",
            async (ctx) => {
              const events = await ctx.runtime.objects.automations
                .forOrg("org-1")
                .http.fetch(
                  new Request("https://automations.test/api/automations/events?limit=50"),
                );
              assert(events.ok);
              const payload = (await events.json()) as {
                events: Array<{
                  source: string;
                  eventType: string;
                  actors: {
                    initiator: {
                      scope: "external";
                      source: string;
                      type: string;
                      id: string;
                      role: "initiator";
                    };
                  };
                }>;
              };
              const event = payload.events.find(
                (event) => event.source === "telegram" && event.eventType === "message.received",
              );
              assert(event);
              expect(event.actors.initiator).toMatchObject({ type: "shared-chat", id: "-1001234" });
              await expect(
                ctx.runtime.objects.otp.forOrg("org-1").commands.issueIdentityClaim(
                  { expiresInMinutes: null },
                  {
                    kind: "deferred",
                    scopeRestriction: null,
                    scope: { kind: "org", orgId: "org-1" },
                    actors: { initiator: event.actors.initiator, principal: null, delegation: [] },
                  },
                ),
              ).rejects.toThrow("cannot be linked to a user");
              assert(ctx.fakes.telegram);
              expect(ctx.fakes.telegram.sendMessageCalls).toEqual([]);
            },
          ),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
