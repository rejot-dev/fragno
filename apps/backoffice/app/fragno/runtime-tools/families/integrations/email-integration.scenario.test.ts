import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeUserContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { Resend } from "resend";

import {
  createBackofficeRequestExecution,
  createBackofficeSystemExecution,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { readAutomationReplica } from "@/fragno/automation/lofi/testing";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { ApiObject } from "../../../../../workers/api-object";
import { AppInstallationsObject } from "../../../../../workers/app-installations-object";
import { AppsObject } from "../../../../../workers/apps-object";
import { AuthObject } from "../../../../../workers/auth-object";
import { AutomationsObject } from "../../../../../workers/automations-object";
import { BillingObject } from "../../../../../workers/billing-object";
import { CodemodeObject } from "../../../../../workers/codemode-object";
import { GitHubObject } from "../../../../../workers/github-object";
import { GitHubWebhookRouterObject } from "../../../../../workers/github-webhook-router-object";
import { McpObject } from "../../../../../workers/mcp-object";
import { OtpObject } from "../../../../../workers/otp-object";
import { ProjectConnectorObject } from "../../../../../workers/project-connector-object";
import { ResendObject } from "../../../../../workers/resend-object";
import { TelegramObject } from "../../../../../workers/telegram-object";
import { UploadObject } from "../../../../../workers/upload-object";
import { createIntegrationsRuntime } from "./integrations-runtime";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  GITHUB: (input) => new GitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new GitHubWebhookRouterObject(input),
  MCP: (input) => new McpObject(input),
  OTP: (input) => new OtpObject(input),
  PROJECT_CONNECTOR: (input) => new ProjectConnectorObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const alice = { kind: "user", userId: "inbound-alice", jurisdiction: null } as const;
const bob = { kind: "user", userId: "inbound-bob", jurisdiction: null } as const;
const webhookSecret = "whsec_c2VjcmV0";

type ReceivedEmail = {
  id: string;
  envelopeTo: string | string[];
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
};

/** The platform Resend account: its webhook, received emails, and attachment downloads. */
function createResendProvider() {
  const received = new Map<string, ReceivedEmail>();
  const attachment = {
    id: "att_1",
    filename: "receipt.pdf",
    size: 48213,
    content_type: "application/pdf",
    content_disposition: "attachment",
    content_id: null,
  };
  function createClient(apiKey: string) {
    // The real client verifies signatures, so webhooks are signed the way Resend signs them.
    const real = new Resend(apiKey);
    const registered = { data: { id: "webhook-1", signing_secret: webhookSecret }, error: null };
    return {
      webhooks: {
        create: async () => registered,
        update: async () => registered,
        verify: (input: Parameters<Resend["webhooks"]["verify"]>[0]) => real.webhooks.verify(input),
      },
      emails: {
        receiving: {
          get: async (id: string) => {
            const email = received.get(id)!;
            return {
              data: {
                id,
                created_at: "2026-11-04T09:00:00.000Z",
                from: email.from,
                to: email.to,
                cc: [],
                bcc: [],
                reply_to: null,
                subject: email.subject,
                message_id: `<${id}@shop.example>`,
                html: email.html,
                text: email.text,
                headers: {},
                attachments: [attachment],
              },
              error: null,
            };
          },
          attachments: {
            get: async ({ emailId, id }: { emailId: string; id: string }) => ({
              data: {
                id,
                download_url: `https://resend.example/attachments/${emailId}/${id}`,
                expires_at: "2026-11-04T10:00:00.000Z",
              },
              error: null,
            }),
          },
        },
      },
    } as never;
  }

  async function sign(id: string, timestamp: string, body: string) {
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(webhookSecret.slice("whsec_".length)), (char) => char.charCodeAt(0)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${timestamp}.${body}`),
    );
    return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
  }

  /** Resend delivers an email to `envelopeTo`; the message's own headers name `to`. */
  async function deliver(ctx: BackofficeScenarioContext, email: ReceivedEmail) {
    received.set(email.id, email);
    const body = JSON.stringify({
      type: "email.received",
      created_at: "2026-11-04T09:00:01.000Z",
      data: {
        email_id: email.id,
        created_at: "2026-11-04T09:00:00.000Z",
        from: email.from,
        to: [email.envelopeTo].flat(),
        cc: [],
        bcc: [],
        subject: email.subject,
        message_id: `<${email.id}@shop.example>`,
        attachments: [attachment],
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await ctx.runtime.objects.resend.for({ kind: "system" }).http.fetch(
      new Request("https://resend.do/api/resend/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": `msg_${email.id}`,
          "svix-timestamp": timestamp,
          "svix-signature": await sign(`msg_${email.id}`, timestamp, body),
        },
        body,
      }),
    );
    assert(response.status === 200);
  }

  return { createClient, deliver };
}

async function receivedEmailEvents(
  ctx: BackofficeScenarioContext,
  scope: BackofficeUserContextScope,
) {
  const page = await ctx.runtime.objects.automations
    .for(scope)
    .commands.listEventsOfType({ source: "email", eventType: "message.received", cursor: null });
  return page.events;
}

const receipt = {
  from: "Shop <Orders@Shop.example>",
  to: ["me@mail.example"],
  subject: "Fwd: Your receipt",
  text: "Total: 12.00 EUR",
  html: "<p>Total: 12.00 EUR</p>",
};

/** Three words from the address list, at the inbound domain. */
const generatedAddress = /^[a-z]+-[a-z]+-[a-z]+@ley\.run$/;

/** Support's terminal: a signed-in administrator in System. */
async function supportTerminal(ctx: BackofficeScenarioContext) {
  const execution = createBackofficeRequestExecution({
    scope: { kind: "system" },
    verifiedRequestAuthority: {
      userId: "support-1",
      personalScope: { kind: "user" as const, userId: "support-1", jurisdiction: null },
      role: "admin",
      organization: null,
      administeredMember: null,
      expiresAt: new Date(Date.now() + 60_000),
      scopeRestriction: null,
    },
  });
  const host = await createInteractiveBashHost({
    context: createCodemodeRouteBackedRuntimeContext({
      emitter: { kind: "caller" },
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      execution,
    }),
  });
  return host.bash;
}

/** What the connection's detail page loads. */
async function describeEmail(ctx: BackofficeScenarioContext) {
  return await createIntegrationsRuntime({
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeSystemExecution(alice),
    nowEpochMs: ctx.runtime.now,
  }).describe({ connectionId: "backoffice#email" });
}

async function currentAddress(ctx: BackofficeScenarioContext, scope: BackofficeUserContextScope) {
  const run = await ctx.runCodemode({
    scope,
    code: `async () => (await integrations.get({ connectionId: "backoffice#email" })).name`,
  });
  return run.result as string;
}

test("each person keeps one random inbound address that only support replaces", async () => {
  const resend = createResendProvider();
  // Each address is drawn at setup, so later steps read the one a step was given.
  const addresses = { alice: "", bob: "", replaced: "" };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Inbound email addresses through the integrations facade",
      env: { INBOUND_EMAIL_DOMAIN: "ley.run" },
      objects: {
        ...scenarioObjects,
        RESEND: (input) => new ResendObject({ ...input, createClient: resend.createClient }),
      },
      setup: ({ given }) => [
        given.auth.user({ id: alice.userId }),
        given.auth.user({ id: bob.userId }),
        given.auth.user({ id: "support-1", role: "admin" }),
      ],
      steps: ({ then, runner }) => [
        then.assert("the platform Resend account is configured", async (ctx) => {
          await ctx.runtime.objects.resend.for({ kind: "system" }).commands.setAdminConfig(
            {
              apiKey: "re_platform_key",
              defaultFrom: "Leyway <noreply@leyway.com>",
              webhookBaseUrl: "https://example.com",
            },
            { kind: "system" },
            "https://example.com",
          );
        }),
        then.assert("setup gives the person an address of three random words", async (ctx) => {
          const registered = await ctx.runCodemode({
            scope: alice,
            code: `async () => {
              const target = { connectionId: "backoffice#email" };
              const check = await integrations.setup({ ...target, kind: "check" });
              const ready = await integrations.setup({ ...target, kind: "input", input: {} });
              return {
                check,
                ready,
                got: await integrations.get(target),
                page: await integrations.list({ cursor: null }),
              };
            }`,
            assertToolCalls: ["integrations.setup", "integrations.get", "integrations.list"],
          });
          expect(registered.result).toMatchObject({
            check: { status: "needs-input", connectionId: "backoffice#email" },
            ready: { status: "ready", connectionId: "backoffice#email" },
            got: { name: expect.stringMatching(generatedAddress) },
            page: {
              connections: [
                {
                  connectionId: "backoffice#email",
                  integrationId: "email",
                  name: expect.stringMatching(generatedAddress),
                  configuration: { status: "configured" },
                },
              ],
            },
          });
          addresses.alice = await currentAddress(ctx, alice);
          expect((await describeEmail(ctx)).details).toEqual({
            kind: "email",
            mailbox: { address: addresses.alice, paused: false },
          });
        }),
        then.assert("a person cannot gather more addresses", async (ctx) => {
          await expect(
            ctx.runCodemode({
              scope: alice,
              code: `async () => await integrations.reconfigure({ connectionId: "backoffice#email", kind: "input", input: {} })`,
            }),
          ).rejects.toThrow("contact support");

          // Disconnecting pauses the address, and setting up again resumes the same one.
          await ctx.runCodemode({
            scope: alice,
            code: `async () => {
              const target = { connectionId: "backoffice#email" };
              await integrations.disconnect({ ...target, confirm: target.connectionId });
              await integrations.setup({ ...target, kind: "input", input: {} });
            }`,
          });
          expect(await currentAddress(ctx, alice)).toBe(addresses.alice);

          await ctx.runCodemode({
            scope: bob,
            code: `async () => await integrations.setup({ connectionId: "backoffice#email", kind: "input", input: {} })`,
          });
          addresses.bob = await currentAddress(ctx, bob);
          expect(addresses.bob).toMatch(generatedAddress);
          expect(addresses.bob).not.toBe(addresses.alice);
        }),
        runner.drain(),
        then.assert("the Integrations page lists the address", async (ctx) => {
          const replica = ctx.lofi.automations.forScope(alice);
          await replica.drain();
          const connections = await readAutomationReplica(
            replica.replica,
            "integrationConnections",
            undefined,
          );
          expect(
            connections.map(({ connectionId, state, displayName, kindLabel }) => ({
              connectionId,
              state,
              displayName,
              kindLabel,
            })),
          ).toEqual([
            {
              connectionId: "backoffice#email",
              state: "ready",
              displayName: addresses.alice,
              kindLabel: "Native · email",
            },
          ]);
        }),
        then.assert("email Resend delivered to the address reaches its owner", async (ctx) => {
          await resend.deliver(ctx, {
            id: "re_receipt",
            envelopeTo: addresses.alice.toUpperCase(),
            ...receipt,
          });
          await resend.deliver(ctx, { id: "re_stray", envelopeTo: "nobody@ley.run", ...receipt });
        }),
        runner.drain(),
        then.assert("the email is an event in the owner's scope", async (ctx) => {
          const events = await receivedEmailEvents(ctx, alice);
          expect(events).toHaveLength(1);
          expect(events[0]).toMatchObject({
            payload: {
              connectionId: "backoffice#email",
              address: addresses.alice,
              from: "Shop <Orders@Shop.example>",
              to: ["me@mail.example"],
              subject: "Fwd: Your receipt",
              text: "Total: 12.00 EUR",
              textTruncated: false,
              attachments: [
                {
                  id: "att_1",
                  filename: "receipt.pdf",
                  contentType: "application/pdf",
                  size: 48213,
                },
              ],
            },
            actors: {
              initiator: {
                scope: "external",
                source: "email",
                type: "sender",
                id: "orders@shop.example",
                role: "initiator",
              },
              principal: null,
              delegation: [],
            },
          });
        }),
        then.assert("only the owner reads the email and its attachments", async (ctx) => {
          const emailId = await emailIdAt(ctx, addresses.alice);
          const read = await ctx.runCodemode({
            scope: alice,
            code: `async () => {
              const execute = (actionId, input) => integrations.execute({ connectionId: "backoffice#email", actionId, input });
              return {
                message: await execute("message.get", { emailId: ${JSON.stringify(emailId)} }),
                attachment: await execute("attachment.get", { emailId: ${JSON.stringify(emailId)}, attachmentId: "att_1" }),
              };
            }`,
          });
          expect(read.result).toMatchObject({
            message: {
              emailId,
              html: "<p>Total: 12.00 EUR</p>",
              to: ["me@mail.example"],
            },
            attachment: {
              id: "att_1",
              downloadUrl: "https://resend.example/attachments/re_receipt/att_1",
            },
          });

          await expect(
            ctx.runCodemode({
              scope: bob,
              code: `async () => await integrations.execute({ connectionId: "backoffice#email", actionId: "message.get", input: { emailId: ${JSON.stringify(emailId)} } })`,
            }),
          ).rejects.toThrow("did not arrive at this person's address");
          expect(await receivedEmailEvents(ctx, bob)).toHaveLength(0);
        }),
        then.assert(
          "support replaces the address, and the old one is never issued again",
          async (ctx) => {
            const bash = await supportTerminal(ctx);
            const replaced = await bash.exec(
              `admin.inbound-email.replace --user ${alice.userId} --format json`,
            );
            assert(replaced.exitCode === 0, replaced.stderr);
            addresses.replaced = (JSON.parse(replaced.stdout) as { address: string }).address;
            expect(addresses.replaced).toMatch(generatedAddress);
            expect(addresses.replaced).not.toBe(addresses.alice);
            expect(await currentAddress(ctx, alice)).toBe(addresses.replaced);

            const inbound = ctx.runtime.objects.inboundEmail.system().commands;
            const carol = { kind: "user", userId: "inbound-carol", jurisdiction: null } as const;
            expect(await inbound.openMailbox(carol, addresses.alice)).toEqual({
              status: "taken",
            });
            await resend.deliver(ctx, { id: "re_old", envelopeTo: addresses.alice, ...receipt });
            await resend.deliver(ctx, { id: "re_new", envelopeTo: addresses.replaced, ...receipt });
          },
        ),
        runner.drain(),
        then.assert(
          "only the new address receives, and earlier email stays readable",
          async (ctx) => {
            const events = await receivedEmailEvents(ctx, alice);
            expect(
              new Set(events.map(({ payload }) => (payload as { address: string }).address)),
            ).toEqual(new Set([addresses.alice, addresses.replaced]));
            expect(events).toHaveLength(2);
            const emailId = await emailIdAt(ctx, addresses.alice);
            await expect(
              ctx.runCodemode({
                scope: alice,
                code: `async () => await integrations.execute({ connectionId: "backoffice#email", actionId: "message.get", input: { emailId: ${JSON.stringify(emailId)} } })`,
              }),
            ).resolves.toMatchObject({ result: { address: addresses.alice } });
          },
        ),
        then.assert("the Integrations page names the new address", async (ctx) => {
          const replica = ctx.lofi.automations.forScope(alice);
          await replica.drain();
          const [connection] = await readAutomationReplica(
            replica.replica,
            "integrationConnections",
            undefined,
          );
          expect(connection).toMatchObject({ state: "ready", displayName: addresses.replaced });
        }),
        then.assert("disconnecting stops delivery", async (ctx) => {
          const released = await ctx.runCodemode({
            scope: alice,
            code: `async () => await integrations.disconnect({ connectionId: "backoffice#email", confirm: "backoffice#email" })`,
          });
          expect(released.result).toMatchObject({ status: "disconnected" });
          await resend.deliver(ctx, { id: "re_late", envelopeTo: addresses.replaced, ...receipt });
        }),
        runner.drain(),
        then.automation.event({
          scope: alice,
          where: { source: "integrations", eventType: "connection.disconnected" },
          expected: { subject: { service: "email", connectionId: "backoffice#email" } },
        }),
        then.assert("email at a paused address records nothing", async (ctx) => {
          expect(await receivedEmailEvents(ctx, alice)).toHaveLength(2);
          expect((await describeEmail(ctx)).details).toEqual({
            kind: "email",
            mailbox: { address: addresses.replaced, paused: true },
          });
        }),
      ],
    }),
  );
});

async function emailIdAt(ctx: BackofficeScenarioContext, address: string) {
  const event = (await receivedEmailEvents(ctx, alice)).find(
    ({ payload }) => (payload as { address: string }).address === address,
  );
  return (event!.payload as { emailId: string }).emailId;
}

/** The grants the receiving-email skill gives a route that acts on email. */
const receivingEmailSkillGrants = [
  BACKOFFICE_PERMISSION.integrations.execute,
  BACKOFFICE_PERMISSION.connections.read,
  BACKOFFICE_PERMISSION.web.download,
  BACKOFFICE_PERMISSION.upload.modify,
  BACKOFFICE_PERMISSION.models.extract,
];

test("a route set up as the receiving-email skill describes reads the email", async () => {
  const resend = createResendProvider();
  let address = "";
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Email route with the skill's grants",
      env: { INBOUND_EMAIL_DOMAIN: "ley.run" },
      objects: {
        ...scenarioObjects,
        RESEND: (input) => new ResendObject({ ...input, createClient: resend.createClient }),
      },
      setup: ({ given }) => [given.auth.user({ id: alice.userId })],
      steps: ({ then, runner }) => [
        then.assert("the person has an address and a route for their receipts", async (ctx) => {
          await ctx.runtime.objects.resend.for({ kind: "system" }).commands.setAdminConfig(
            {
              apiKey: "re_platform_key",
              defaultFrom: "Leyway <noreply@leyway.com>",
              webhookBaseUrl: "https://example.com",
            },
            { kind: "system" },
            "https://example.com",
          );
          await ctx.files.forUser(alice.userId).writeFile(
            "/workspace/automations/receipt-intake.workflow.js",
            `export default defineWorkflow({ name: "receipt-intake" }, async (event, step) => {
              const { connectionId, emailId } = event.payload;
              return await step.do("read", async () => {
                const execute = (actionId, input) => integrations.execute({ connectionId, actionId, input });
                const message = await execute("message.get", { emailId });
                const attachment = await execute("attachment.get", { emailId, attachmentId: "att_1" });
                return { subject: message.subject, downloadUrl: attachment.downloadUrl };
              });
            });`,
          );
          await ctx.runCodemode({
            scope: alice,
            code: `async () => {
              await integrations.setup({ connectionId: "backoffice#email", kind: "input", input: {} });
              await router.create({
                id: "receipt-intake",
                name: "Receipt intake",
                trigger: {
                  kind: "event",
                  source: "email",
                  eventType: "message.received",
                  matcher: { path: "$.payload.from", op: "includes", value: "@Shop.example" },
                },
                action: {
                  kind: "start_workflow",
                  authority: { kind: "organization-automation", grants: ${JSON.stringify(receivingEmailSkillGrants)} },
                  workflowScriptPath: "/workspace/automations/receipt-intake.workflow.js",
                  instanceIdTemplate: "receipt-\${event.id}",
                },
              });
            }`,
          });
          address = await currentAddress(ctx, alice);
          await resend.deliver(ctx, { id: "re_receipt", envelopeTo: address, ...receipt });
        }),
        runner.drain(),
        then.assert("the workflow read the email and its attachment", async (ctx) => {
          // Instance IDs replace the event ID's colon.
          const instanceId = `receipt-email-${await emailIdAt(ctx, address)}`;
          const run = await ctx.runCodemode({
            scope: alice,
            code: `async () => await workflow.getInstance({ instanceId: ${JSON.stringify(instanceId)} })`,
          });
          expect(run.result).toMatchObject({
            details: {
              status: "complete",
              output: {
                subject: "Fwd: Your receipt",
                downloadUrl: expect.stringContaining("/att_1"),
              },
            },
          });
        }),
      ],
    }),
  );
});

test("an email to two people's addresses reaches each of them once", async () => {
  const resend = createResendProvider();
  const addresses = { alice: "", bob: "" };
  const people = { alice, bob };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "One email to two inbound addresses",
      env: { INBOUND_EMAIL_DOMAIN: "ley.run" },
      objects: {
        ...scenarioObjects,
        RESEND: (input) => new ResendObject({ ...input, createClient: resend.createClient }),
      },
      setup: ({ given }) => [
        given.auth.user({ id: alice.userId }),
        given.auth.user({ id: bob.userId }),
      ],
      steps: ({ then, runner }) => [
        then.assert("the shop emails both people, and Resend reports it twice", async (ctx) => {
          await ctx.runtime.objects.resend.for({ kind: "system" }).commands.setAdminConfig(
            {
              apiKey: "re_platform_key",
              defaultFrom: "Leyway <noreply@leyway.com>",
              webhookBaseUrl: "https://example.com",
            },
            { kind: "system" },
            "https://example.com",
          );
          for (const name of ["alice", "bob"] as const) {
            await ctx.runCodemode({
              scope: people[name],
              code: `async () => await integrations.setup({ connectionId: "backoffice#email", kind: "input", input: {} })`,
            });
            addresses[name] = await currentAddress(ctx, people[name]);
          }
          const shared = { id: "re_shared", envelopeTo: [addresses.alice, addresses.bob] };
          await resend.deliver(ctx, { ...shared, ...receipt });
          await resend.deliver(ctx, { ...shared, ...receipt });
        }),
        runner.drain(),
        then.assert("each reads it, with its attachment, at their own address", async (ctx) => {
          for (const name of ["alice", "bob"] as const) {
            const events = await receivedEmailEvents(ctx, people[name]);
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({ payload: { address: addresses[name] } });
            const { emailId } = events[0]!.payload as { emailId: string };
            const read = await ctx.runCodemode({
              scope: people[name],
              code: `async () => {
                const execute = (actionId, input) => integrations.execute({ connectionId: "backoffice#email", actionId, input });
                return {
                  message: await execute("message.get", { emailId: ${JSON.stringify(emailId)} }),
                  attachment: await execute("attachment.get", { emailId: ${JSON.stringify(emailId)}, attachmentId: "att_1" }),
                };
              }`,
            });
            expect(read.result).toMatchObject({
              message: { emailId, address: addresses[name], subject: "Fwd: Your receipt" },
              attachment: { id: "att_1" },
            });
          }
        }),
      ],
    }),
  );
});

test("setup is blocked until the platform Resend account is configured", async () => {
  const resend = createResendProvider();
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Email setup without the platform account",
      env: { INBOUND_EMAIL_DOMAIN: "ley.run" },
      objects: {
        ...scenarioObjects,
        RESEND: (input) => new ResendObject({ ...input, createClient: resend.createClient }),
      },
      setup: ({ given }) => [given.auth.user({ id: alice.userId })],
      steps: ({ then }) => [
        then.assert("setup says why, and no connection is listed", async (ctx) => {
          const { result } = await ctx.runCodemode({
            scope: alice,
            code: `async () => ({
              setup: await integrations.setup({ connectionId: "backoffice#email", kind: "check" }),
              page: await integrations.list({ cursor: null }),
            })`,
          });
          expect(result).toMatchObject({
            setup: {
              connectionId: "backoffice#email",
              status: "blocked",
              reason: expect.stringContaining("platform Resend account is not configured"),
            },
            page: { connections: [] },
          });
        }),
      ],
    }),
  );
});
