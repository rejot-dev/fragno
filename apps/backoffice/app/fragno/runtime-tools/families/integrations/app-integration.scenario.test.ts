import { afterAll, assert, beforeAll, expect, test, vi } from "vitest";

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
import type { AppActionsDeclaration } from "@fragno-dev/backoffice-api/v0/apps";
import { automationEventListResultSchema } from "@fragno-dev/backoffice-api/v0/events";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";
import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { InMemoryAppInstallationsObject } from "../../../../../workers/app-installations.do";

const org = { kind: "org", orgId: "org-1" } as const;
const endpointUrl = "https://ledger.example/backoffice/actions";
const clientPath = "/workspace/integrations/app/ledger.js";

const yearInput = {
  type: "object",
  properties: { year: { type: "integer", description: "Fiscal year." } },
  required: ["year"],
  additionalProperties: false,
};
const countOutput = {
  type: "object",
  properties: { count: { type: "integer" } },
  required: ["count"],
  additionalProperties: false,
};
const countInvoices = {
  id: "invoices.count",
  label: "Count invoices",
  description: "Count the invoices issued in one fiscal year.",
  inputSchema: yearInput,
  outputSchema: countOutput,
};
const brokenCount = { ...countInvoices, id: "invoices.broken", label: "Broken count" };
const closePeriod = {
  id: "periods.close",
  label: "Close period",
  description: "Close a fiscal year for further bookings.",
  inputSchema: yearInput,
  outputSchema: { type: "object" },
};
const listInvoices = {
  id: "invoices.list",
  label: "List invoices",
  description: "List invoice numbers issued in one fiscal year.",
  inputSchema: yearInput,
  outputSchema: {
    type: "object",
    properties: { numbers: { type: "array", items: { type: "string" } } },
    required: ["numbers"],
  },
};

function declaration(
  changeApproval: "installation" | "automatic",
  actions: Extract<AppActionsDeclaration, { kind: "endpoint" }>["actions"],
): AppActionsDeclaration {
  return { kind: "endpoint", endpointUrl, changeApproval, actions };
}

/** Ledger's own server: verifies Backoffice's signature the way any app would, then answers. */
function createLedgerApp() {
  const received: VerifiedAppActionRequest[] = [];
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
    received.push(verified);
    const call = verified.request;
    if (call.type === "ping") {
      return Response.json({ ok: true });
    }
    switch (call.actionId) {
      case "invoices.count":
        return Response.json({ count: 3 });
      case "invoices.broken":
        return Response.json({ total: 3 });
      case "invoices.list":
        return Response.json({ numbers: ["2025-001", "2025-002", "2025-003"] });
      default:
        return Response.json({ message: "Period 2024 is already closed." }, { status: 422 });
    }
  }
  return { received, handle };
}

let codemodeServer: Awaited<ReturnType<typeof createCodemodeTestServer>>;
beforeAll(async () => {
  codemodeServer = await createCodemodeTestServer((compile) => compile);
});
afterAll(async () => {
  await codemodeServer?.close();
});

async function terminal(
  ctx: BackofficeScenarioContext,
  scope: BackofficeContextScope,
  userId: string,
) {
  const context = createRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeUserExecution({ scope, userId }),
  });
  assert(context.stateBackend);
  return (
    await createInteractiveBashHost({
      context: { ...context, stateBackend: context.stateBackend },
    })
  ).bash;
}

async function run(bash: Awaited<ReturnType<typeof terminal>>, command: string) {
  const result = await bash.exec(command);
  assert.equal(result.exitCode, 0, `${command}\n${result.stderr}`);
  return result.stdout;
}

async function runJson(
  bash: Awaited<ReturnType<typeof terminal>>,
  command: string,
): Promise<unknown> {
  return JSON.parse(await run(bash, `${command} --format json`));
}

async function fails(bash: Awaited<ReturnType<typeof terminal>>, command: string) {
  const result = await bash.exec(command);
  assert.notEqual(result.exitCode, 0, `${command} succeeded:\n${result.stdout}`);
  return result.stderr;
}

const quote = (value: unknown) => `'${JSON.stringify(value)}'`;

/** The newest integrations.connection.* state recorded for the connection, after hooks ran. */
async function latestConnectionState(ctx: BackofficeScenarioContext, connectionId: string) {
  await ctx.drain();
  const response = await ctx.runtime.objects.automations
    .for(org)
    .http.fetch(new Request("https://automations.test/api/automations/events?limit=500"));
  assert(response.ok, await response.clone().text());
  const [latest] = automationEventListResultSchema
    .parse(await response.json())
    .events.filter(
      (event) =>
        event.source === "integrations" &&
        (event.subject as { connectionId?: unknown } | null)?.connectionId === connectionId,
    );
  return latest?.eventType ?? null;
}

test("an installed app's declared actions run on its server, signed per call and gated by approval", async () => {
  const ledger = createLedgerApp();
  let appId = "";
  const connection = () => "'app#ledger'";
  const execute = (actionId: string, input: unknown) =>
    `integrations.execute --connection-id ${connection()} --action-id ${actionId} --input-json ${quote(input)}`;
  const actionIds = async (bash: Awaited<ReturnType<typeof terminal>>) =>
    (
      (await runJson(bash, `integrations.actions --connection-id ${connection()}`)) as {
        id: string;
      }[]
    ).map(({ id }) => id);

  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "app actions",
      objects: {
        ...allLocalObjects,
        APP_INSTALLATIONS: (options) =>
          new InMemoryAppInstallationsObject({
            ...options,
            fetch: async (input, init) =>
              await ledger.handle(options.runtime, new Request(input, init)),
          }),
      },
      env: { codemode: createCodemodeNodeExecutor(codemodeServer) },
      setup: ({ given }) => [
        given.auth.user({ id: "global-admin", role: "admin" }),
        given.auth.user({ id: "owner" }),
        given.auth.organization({ id: org.orgId, ownerUserId: "owner" }),
      ],
      steps: ({ then }) => [
        then.assert("an administrator registers Ledger with its actions", async (ctx) => {
          const client = await ctx.runtime.objects.auth
            .singleton()
            .commands.createAdminOAuthClient({
              administratorUserId: "global-admin",
              name: "Ledger",
              redirectUris: ["https://ledger.example/callback"],
              scopes: ["openid", "backoffice"],
            });
          const admin = await terminal(ctx, { kind: "system" }, "global-admin");
          const unenforceable = declaration("installation", [
            {
              ...countInvoices,
              inputSchema: { $schema: "http://json-schema.org/draft-04/schema#", type: "object" },
            },
          ]);
          expect(
            await fails(
              admin,
              `admin.apps.create --slug ledger --oauth-client-id ${client.clientId} --requested-permissions-json '[]' --actions-json ${quote(unenforceable)}`,
            ),
          ).toContain("input schema Backoffice cannot validate");
          const created = (await runJson(
            admin,
            `admin.apps.create --slug ledger --oauth-client-id ${client.clientId} --requested-permissions-json '[]' --actions-json ${quote(declaration("installation", [countInvoices, brokenCount, closePeriod]))}`,
          )) as { appId: string };
          appId = created.appId;
        }),
        then.assert(
          "the owner reviews the actions, installs Ledger, and Ledger links the installation",
          async (ctx) => {
            const owner = await terminal(ctx, org, "owner");
            const review = await run(owner, `apps.get --app-id ${appId}`);
            expect(review).toContain("Slug: ledger (integration connection app#ledger)\n");
            expect(review).toContain("Actions revision: 1\n");
            expect(review).toContain(
              "  invoices.count: Count invoices. Count the invoices issued in one fiscal year.\n",
            );
            await run(
              owner,
              `apps.install --app-id ${appId} --granted-permissions-json '[]' --actions-revision 1`,
            );
            assert((await latestConnectionState(ctx, "app#ledger")) === "connection.unavailable");
            expect(
              await runJson(owner, `integrations.get --connection-id ${connection()}`),
            ).toMatchObject({
              authorization: { status: "missing" },
              nextSteps: [
                "The app has not linked this installation to one of its accounts; finish the app's connect flow.",
              ],
            });
            const claimed = await ctx.runtime.objects.appInstallations
              .forOrg(org.orgId)
              .commands.claimInstallation({
                appId,
                activation: 1,
                externalAccount: { id: "ledger-org-7", label: "Acme Books" },
              });
            assert(claimed.ok);
            assert((await latestConnectionState(ctx, "app#ledger")) === "connection.ready");
            expect(
              await runJson(owner, `integrations.verify --connection-id ${connection()}`),
            ).toMatchObject({
              checks: [{ id: "endpoint.ping", status: "passed" }],
            });
            expect(await runJson(owner, "integrations.list")).toMatchObject({
              connections: [
                {
                  connectionId: "app#ledger",
                  integrationId: "app",
                  name: "Ledger",
                  authorization: { status: "available" },
                },
              ],
            });
          },
        ),
        then.assert(
          "actions run on Ledger with the caller's identity, and contracts hold both ways",
          async (ctx) => {
            const owner = await terminal(ctx, org, "owner");
            expect(await runJson(owner, execute("invoices.count", { year: 2025 }))).toEqual({
              count: 3,
            });
            expect(ledger.received.at(-1)).toMatchObject({
              claims: {
                aud: endpointUrl,
                actor: { kind: "user", userId: "owner" },
                installation: {
                  appId,
                  activation: 1,
                  externalAccount: { id: "ledger-org-7", label: "Acme Books" },
                },
                scopeRestriction: org,
              },
              request: { type: "action", actionId: "invoices.count", input: { year: 2025 } },
            });
            const delivered = ledger.received.length;
            expect(await fails(owner, execute("invoices.count", { year: "2025" }))).toContain(
              "App action 'invoices.count' input failed its declared JSON Schema.",
            );
            expect(ledger.received).toHaveLength(delivered);
            expect(await fails(owner, execute("invoices.broken", { year: 2025 }))).toContain(
              "App action 'invoices.broken' returned output that failed its declared schema.",
            );
            expect(await fails(owner, execute("periods.close", { year: 2024 }))).toContain(
              "App action 'periods.close' failed with HTTP 422: Period 2024 is already closed.",
            );
          },
        ),
        then.assert(
          "a generated client calls Ledger from codemode as the installation",
          async (ctx) => {
            const owner = await terminal(ctx, org, "owner");
            expect(
              await run(
                owner,
                `integrations.generateClient --connection-id ${connection()} --out ${clientPath}`,
              ),
            ).toBe(
              `${clientPath}\ninvoicesCount\tinvoices.count\ninvoicesBroken\tinvoices.broken\nperiodsClose\tperiods.close\n`,
            );
            const result = await ctx.runCodemode({
              scope: org,
              code: `async () => {
              const { invoicesCount } = await import(${JSON.stringify(clientPath)});
              return await invoicesCount({ year: 2025 });
            }`,
              assertToolCalls: ["integrations.execute"],
            });
            expect(result.result).toEqual({ count: 3 });
            expect(ledger.received.at(-1)?.claims.actor).toEqual({ kind: "installation" });
          },
        ),
        then.assert(
          "changed actions wait for the owner's approval of the reviewed revision",
          async (ctx) => {
            const admin = await terminal(ctx, { kind: "system" }, "global-admin");
            const owner = await terminal(ctx, org, "owner");
            expect(
              await runJson(
                admin,
                `admin.apps.update-actions --app-id ${appId} --actions-json ${quote(declaration("installation", [countInvoices, brokenCount, closePeriod, listInvoices]))}`,
              ),
            ).toEqual({ actionsRevision: 2, changed: true });
            expect(await actionIds(owner)).toEqual([
              "invoices.count",
              "invoices.broken",
              "periods.close",
            ]);
            expect(
              await runJson(owner, `integrations.get --connection-id ${connection()}`),
            ).toMatchObject({
              authorization: { status: "available" },
              nextSteps: [
                "The app's actions changed (revision 2). Review them with apps.get and approve them with apps.installations.approveActions to run new or changed actions; until then the approved actions run.",
              ],
            });
            expect(await fails(owner, execute("invoices.list", { year: 2025 }))).toContain(
              "Integrations action not found.",
            );
            expect(
              await fails(
                owner,
                `apps.installations.approve-actions --app-id ${appId} --actions-revision 1`,
              ),
            ).toContain(
              "Backoffice app actions changed since revision 1; review revision 2 with apps.get.",
            );
            await run(
              owner,
              `apps.installations.approve-actions --app-id ${appId} --actions-revision 2`,
            );
            expect(await runJson(owner, execute("invoices.list", { year: 2025 }))).toEqual({
              numbers: ["2025-001", "2025-002", "2025-003"],
            });
          },
        ),
        then.assert(
          "automatic declarations apply at once, and uninstalling removes the connection",
          async (ctx) => {
            const admin = await terminal(ctx, { kind: "system" }, "global-admin");
            const owner = await terminal(ctx, org, "owner");
            await run(
              admin,
              `admin.apps.update-actions --app-id ${appId} --actions-json ${quote(declaration("automatic", [countInvoices]))}`,
            );
            expect(await actionIds(owner)).toEqual(["invoices.count"]);
            await run(owner, `apps.uninstall --app-id ${appId}`);
            assert((await latestConnectionState(ctx, "app#ledger")) === "connection.disconnected");
            expect(await runJson(owner, "integrations.list")).toMatchObject({ connections: [] });
            expect(await actionIds(owner)).toEqual([]);
            expect(await fails(owner, execute("invoices.count", { year: 2025 }))).toContain(
              "Integrations action not found.",
            );
          },
        ),
        then.hooks.noFailed({ orgId: org.orgId, fragments: ["automations"] }),
      ],
    }),
  );
});
