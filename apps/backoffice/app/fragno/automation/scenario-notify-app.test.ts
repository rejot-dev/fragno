import { assert, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import {
  AppActionRequestError,
  createAppActionVerifier,
  type VerifiedAppActionRequest,
} from "@fragno-dev/backoffice-api/v0/app-actions";
import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import {
  createBackofficeUserExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  createInstalledAppExecution,
  installedAppEventSource,
} from "@/fragno/app-installations/authority";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { AppInstallationsObject } from "../../../workers/app-installations-object";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "./scenario";

const org = { kind: "org", orgId: "org-1", jurisdiction: null } as const;
const endpointUrl = "https://ledger.example/backoffice/actions";
const externalAccount = { id: "ledger-org-7", label: "Acme Books" };
const grants = [
  BACKOFFICE_PERMISSION.router.read,
  BACKOFFICE_PERMISSION.router.modify,
  BACKOFFICE_PERMISSION.events.read,
  BACKOFFICE_PERMISSION.events.emit,
];
const inbox = (appId: string) => ({
  id: "ledger-inbox",
  name: "Ledger inbox",
  trigger: { kind: "event", source: "*", eventType: "invoice.paid" },
  action: { kind: "notify_app", appId },
});

/** Ledger's server: verifies Backoffice's signature like any app, then answers as it is told to. */
function createLedgerApp() {
  const notified: VerifiedAppActionRequest[] = [];
  let status = 200;
  let verify: ((request: Request) => Promise<VerifiedAppActionRequest>) | null = null;
  async function handle(runtime: BackofficeRuntimeServices, request: Request) {
    verify ??= createAppActionVerifier({
      backofficeOrigin: "https://backoffice.test",
      endpointUrl,
      fetch: async (input, init) =>
        await runtime.objects.auth.singleton().http.fetch(new Request(input, init)),
    });
    let verified: VerifiedAppActionRequest;
    try {
      verified = await verify(request);
    } catch (error) {
      if (error instanceof AppActionRequestError) {
        return Response.json({ message: error.message }, { status: error.status });
      }
      throw error;
    }
    notified.push(verified);
    return Response.json({ received: true }, { status });
  }
  return {
    /** The notifications Ledger took about one event. */
    notifiedOf(eventId: string) {
      return notified.filter(
        ({ request }) => request.type === "event" && request.eventId === eventId,
      );
    },
    handle,
    answerWith(next: number) {
      status = next;
    },
  };
}

function invoicePaid(id: string): AutomationEvent {
  return {
    id,
    scope: org,
    scopeRestriction: null,
    source: "billing",
    eventType: "invoice.paid",
    occurredAt: "2026-10-01T00:00:00.000Z",
    payload: { invoice: id },
    actors: {
      initiator: {
        scope: "external",
        source: "billing",
        type: "processor",
        id: "stripe",
        role: "initiator",
      },
      principal: null,
      delegation: [],
    },
    subject: null,
    causation: { kind: "origin" },
  };
}

async function terminal(
  ctx: BackofficeScenarioContext,
  execution: BackofficeExecutionContext,
  emittedEventSource?: string,
) {
  const context = createRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution,
    emittedEventSource,
  });
  assert(context.stateBackend);
  return (
    await createInteractiveBashHost({
      context: { ...context, stateBackend: context.stateBackend },
    })
  ).bash;
}

type Bash = Awaited<ReturnType<typeof terminal>>;

const owner = (ctx: BackofficeScenarioContext) =>
  terminal(ctx, createBackofficeUserExecution({ scope: org, userId: "owner" }));

/** Ledger's server calling Backoffice as its installation, as its execution credential would. */
const ledgerServer = (ctx: BackofficeScenarioContext, appId: string) =>
  terminal(
    ctx,
    createInstalledAppExecution({
      scope: org,
      actor: { kind: "installation" },
      installation: { appId, activation: 1, externalAccount },
    }),
    installedAppEventSource(appId),
  );

async function run(bash: Bash, command: string) {
  const result = await bash.exec(command);
  assert.equal(result.exitCode, 0, `${command}\n${result.stderr}`);
  return result.stdout;
}

async function runJson(bash: Bash, command: string): Promise<unknown> {
  return JSON.parse(await run(bash, `${command} --format json`));
}

async function fails(bash: Bash, command: string) {
  const result = await bash.exec(command);
  assert.notEqual(result.exitCode, 0, `${command} succeeded:\n${result.stdout}`);
  return result.stderr;
}

const quote = (value: unknown) => `'${JSON.stringify(value)}'`;

/** Where the inbox route stands on an event, as Ledger reads it. */
async function inboxDispatch(bash: Bash, eventId: string) {
  const event = (await runJson(bash, `events.get --id ${eventId}`)) as {
    routing: { status: string; routes?: { routeId: string }[] };
  };
  return event.routing.routes?.find(({ routeId }) => routeId === "ledger-inbox");
}

test("a notify_app route tells an installed app about events, which it reads under its own grants", async () => {
  const ledger = createLedgerApp();
  let appId = "";

  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "notify app",
      objects: {
        ...allLocalObjects,
        APP_INSTALLATIONS: (options) =>
          new AppInstallationsObject({
            ...options,
            fetch: async (input, init) =>
              await ledger.handle(options.runtime, new Request(input, init)),
          }),
      },
      setup: ({ given }) => [
        given.auth.user({ id: "global-admin", role: "admin" }),
        given.auth.user({ id: "owner" }),
        given.auth.organization({ id: org.orgId, ownerUserId: "owner" }),
      ],
      steps: ({ when, then, runner }) => [
        then.assert(
          "the owner installs Ledger, which may read events and route them",
          async (ctx) => {
            const client = await ctx.runtime.objects.auth
              .singleton()
              .commands.createAdminOAuthClient({
                administratorUserId: "global-admin",
                name: "Ledger",
                redirectUris: ["https://ledger.example/callback"],
                scopes: ["openid", "backoffice"],
              });
            const admin = await terminal(
              ctx,
              createBackofficeUserExecution({ scope: { kind: "system" }, userId: "global-admin" }),
            );
            const actions = {
              kind: "endpoint",
              endpointUrl,
              changeApproval: "installation",
              actions: [
                {
                  id: "invoices.count",
                  label: "Count invoices",
                  description: "Count the invoices issued.",
                  inputSchema: { type: "object" },
                  outputSchema: { type: "object" },
                },
              ],
            };
            appId = (
              (await runJson(
                admin,
                `admin.apps.create --slug ledger --oauth-client-id ${client.clientId} --requested-permissions-json ${quote(grants)} --actions-json ${quote(actions)}`,
              )) as { appId: string }
            ).appId;
            await runJson(
              await owner(ctx),
              `apps.install --app-id ${appId} --granted-permissions-json ${quote(grants)} --actions-revision 1`,
            );
            const claimed = await ctx.runtime.objects.appInstallations
              .for(org)
              .commands.claimInstallation({ appId, activation: 1, externalAccount });
            assert(claimed.ok);
          },
        ),
        then.assert("Ledger routes events to itself, and only to itself", async (ctx) => {
          const ledgerBash = await ledgerServer(ctx, appId);
          expect(
            await runJson(ledgerBash, `router.create --json ${quote(inbox(appId))}`),
          ).toMatchObject({ id: "ledger-inbox", steward: { kind: "app", appId } });
          expect(
            await fails(
              ledgerBash,
              `router.create --json ${quote({ ...inbox(appId), id: "ledger-other", action: { kind: "notify_app", appId: "other-app" } })}`,
            ),
          ).toContain(`is written by app '${appId}', which may only notify itself`);
          expect(
            await fails(
              ledgerBash,
              `router.create --json ${quote({
                ...inbox(appId),
                id: "ledger-workflow",
                action: {
                  kind: "start_workflow",
                  authority: { kind: "organization-automation", grants: [] },
                  workflowScriptPath: "/workspace/automations/sync.workflow.js",
                  instanceIdTemplate: "sync-${event.id}",
                },
              })}`,
            ),
          ).toContain("which may only notify itself");
        }),
        then.assert(
          "Ledger cannot touch the members' routes, nor they its definition",
          async (ctx) => {
            const ownerBash = await owner(ctx);
            const ledgerBash = await ledgerServer(ctx, appId);
            await runJson(
              ownerBash,
              `router.create --json ${quote({
                ...inbox(appId),
                id: "payroll",
                name: "Payroll",
                trigger: { kind: "event", source: "payroll", eventType: "run.closed" },
              })}`,
            );
            expect(
              await fails(ledgerBash, `router.update --id payroll --json '{"enabled":false}'`),
            ).toContain(`Automation route 'payroll' is not managed by app '${appId}'.`);
            expect(await fails(ledgerBash, "router.delete --id payroll")).toContain(
              `is not managed by app '${appId}'`,
            );
            expect(
              await fails(ownerBash, `router.update --id ledger-inbox --json '{"name":"Mine"}'`),
            ).toContain(`is managed by app '${appId}'`);
            expect(
              await runJson(
                ownerBash,
                `router.update --id ledger-inbox --json '{"enabled":false}'`,
              ),
            ).toMatchObject({ enabled: false, steward: { kind: "app", appId } });
            await runJson(ownerBash, `router.update --id ledger-inbox --json '{"enabled":true}'`);
            await run(ownerBash, "router.delete --id payroll");
          },
        ),
        when.automation.ingestEvent(invoicePaid("invoice-1")),
        then.assert(
          "Ledger is told the event exists, and reads it in the signed scope",
          async (ctx) => {
            expect(ledger.notifiedOf("invoice-1")).toHaveLength(1);
            expect(ledger.notifiedOf("invoice-1")[0]).toMatchObject({
              claims: {
                aud: endpointUrl,
                actor: { kind: "installation" },
                installation: { appId, activation: 1, externalAccount },
                scopeRestriction: org,
              },
              request: { type: "event", eventId: "invoice-1" },
            });
            const ledgerBash = await ledgerServer(ctx, appId);
            expect(await runJson(ledgerBash, "events.get --id invoice-1")).toMatchObject({
              source: "billing",
              eventType: "invoice.paid",
              payload: { invoice: "invoice-1" },
            });
            expect(await inboxDispatch(ledgerBash, "invoice-1")).toMatchObject({
              status: "completed",
              outcome: { kind: "app_notified", appId },
              failedAttempts: 0,
            });
          },
        ),
        then.assert("Ledger's own events are not sent back to it", async (ctx) => {
          const ledgerBash = await ledgerServer(ctx, appId);
          const { eventId } = (await runJson(
            ledgerBash,
            "events.fire --event-type invoice.paid",
          )) as { eventId: string };
          await ctx.drain();
          expect(await inboxDispatch(ledgerBash, eventId)).toMatchObject({
            status: "completed",
            outcome: { kind: "skipped", reason: "caused_by_notified_app" },
          });
          expect(ledger.notifiedOf(eventId)).toEqual([]);
        }),
        then.assert(
          "nor are they once another route makes them look like someone else's",
          async (ctx) => {
            await runJson(
              await owner(ctx),
              `router.create --json ${quote({
                id: "drafts-as-paid",
                name: "Drafts as paid",
                trigger: {
                  kind: "event",
                  source: installedAppEventSource(appId),
                  eventType: "invoice.drafted",
                },
                action: {
                  kind: "reclassify_event",
                  source: "billing",
                  eventType: "invoice.paid",
                  payload: { kind: "projection", fields: {} },
                },
              })}`,
            );
            const ledgerBash = await ledgerServer(ctx, appId);
            const { eventId } = (await runJson(
              ledgerBash,
              "events.fire --event-type invoice.drafted",
            )) as { eventId: string };
            await ctx.drain();
            const reclassifiedId = `reclassified:drafts-as-paid:${eventId}`;
            expect(await runJson(ledgerBash, `events.get --id ${reclassifiedId}`)).toMatchObject({
              source: "billing",
              eventType: "invoice.paid",
            });
            expect(await inboxDispatch(ledgerBash, reclassifiedId)).toMatchObject({
              status: "completed",
              outcome: { kind: "skipped", reason: "caused_by_notified_app" },
            });
            expect(ledger.notifiedOf(reclassifiedId)).toEqual([]);
          },
        ),
        then.assert("an unavailable Ledger is told again once it is back", async (ctx) => {
          ledger.answerWith(503);
          ctx.rememberOrg(org.orgId);
          await ctx.runtime.objects.automations
            .for(org)
            .commands.ingestEvent(invoicePaid("invoice-2"));
          await ctx.drain();
          const ledgerBash = await ledgerServer(ctx, appId);
          expect(await inboxDispatch(ledgerBash, "invoice-2")).toMatchObject({
            status: "retrying",
            failedAttempts: 1,
            error: `App ${appId} answered the event notification with HTTP 503.`,
          });
          ledger.answerWith(200);
          ctx.runtime.advanceTime(2_000);
          await ctx.drain();
          expect(await inboxDispatch(ledgerBash, "invoice-2")).toMatchObject({
            status: "completed",
            outcome: { kind: "app_notified", appId },
            failedAttempts: 1,
          });
          expect(ledger.notifiedOf("invoice-2")).toHaveLength(2);
        }),
        then.assert("a refusing Ledger fails at once, until the owner retries it", async (ctx) => {
          ledger.answerWith(422);
          await ctx.runtime.objects.automations
            .for(org)
            .commands.ingestEvent(invoicePaid("invoice-3"));
          await ctx.drain();
          const ownerBash = await owner(ctx);
          expect(await inboxDispatch(ownerBash, "invoice-3")).toMatchObject({
            status: "failed",
            failedAttempts: 1,
            error: `App ${appId} refused the event notification with HTTP 422.`,
          });
          ledger.answerWith(200);
          await runJson(ownerBash, "events.routes.retry --event invoice-3 --route ledger-inbox");
          await ctx.drain();
          expect(await inboxDispatch(ownerBash, "invoice-3")).toMatchObject({
            status: "completed",
            outcome: { kind: "app_notified", appId },
          });
        }),
        then.assert("without events.read, Ledger is not told", async (ctx) => {
          await runJson(
            await owner(ctx),
            `apps.installations.update --app-id ${appId} --granted-permissions-json ${quote(grants.filter((grant) => grant !== BACKOFFICE_PERMISSION.events.read))} --resource-scope-json '{"kind":"owner"}'`,
          );
          await ctx.runtime.objects.automations
            .for(org)
            .commands.ingestEvent(invoicePaid("invoice-4"));
          await ctx.drain();
          expect(await inboxDispatch(await owner(ctx), "invoice-4")).toMatchObject({
            status: "completed",
            outcome: { kind: "skipped", reason: "app_cannot_read_events" },
          });
          expect(ledger.notifiedOf("invoice-4")).toEqual([]);
        }),
        then.assert("once Ledger is uninstalled, members delete the route it left", async (ctx) => {
          const ownerBash = await owner(ctx);
          await runJson(ownerBash, `apps.uninstall --app-id ${appId}`);
          await ctx.runtime.objects.automations
            .for(org)
            .commands.ingestEvent(invoicePaid("invoice-5"));
          await ctx.drain();
          expect(await inboxDispatch(ownerBash, "invoice-5")).toMatchObject({
            status: "completed",
            outcome: { kind: "skipped", reason: "app_not_installed" },
          });
          await run(ownerBash, "router.delete --id ledger-inbox");
          expect(await fails(ownerBash, "router.get --id ledger-inbox")).toContain(
            "Automation route not found.",
          );
        }),
        runner.drain(),
        then.hooks.noFailed({ orgId: org.orgId, fragments: ["automations"] }),
      ],
    }),
  );
});
