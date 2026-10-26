import { expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { readAutomationReplica } from "@/fragno/automation/lofi/testing";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createIntegrationsRuntime } from "@/fragno/runtime-tools/families/integrations/integrations-runtime";

import { ApiObject } from "../../../../workers/api.do";
import { AppInstallationsObject } from "../../../../workers/app-installations.do";
import { AppsObject } from "../../../../workers/apps.do";
import { AuthObject } from "../../../../workers/auth.do";
import { AutomationsObject } from "../../../../workers/automations.do";
import { BillingObject } from "../../../../workers/billing.do";
import { CodemodeObject } from "../../../../workers/codemode.do";
import { FormsObject } from "../../../../workers/forms.do";
import { GitHubWebhookRouterObject } from "../../../../workers/github-webhook-router.do";
import { GitHubObject } from "../../../../workers/github.do";
import { McpObject } from "../../../../workers/mcp.do";
import { OtpObject } from "../../../../workers/otp.do";
import { ProjectConnectorObject } from "../../../../workers/project-connector.do";
import { ResendObject } from "../../../../workers/resend.do";
import { TelegramObject } from "../../../../workers/telegram.do";
import { UploadObject } from "../../../../workers/upload.do";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  FORMS: (input) => new FormsObject(input),
  GITHUB: (input) => new GitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new GitHubWebhookRouterObject(input),
  MCP: (input) => new McpObject(input),
  OTP: (input) => new OtpObject(input),
  PROJECT_CONNECTOR: (input) => new ProjectConnectorObject(input),
  RESEND: (input) => new ResendObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const orgId = "integrations-org";
const scope = { kind: "org", orgId } as const;
const secrets = {
  token: "scenario-billing-token",
  signing: "scenario-signing-secret",
  telegram: "123456:scenario-telegram-token",
};

/** Reads the details the connection panel's loader shows. */
async function describeConnection(ctx: BackofficeScenarioContext, connectionId: string) {
  return await createIntegrationsRuntime({
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeSystemExecution(scope),
    nowEpochMs: ctx.runtime.now,
  }).describe({ connectionId });
}

test("the integrations section shows each connection's reported state and source details", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Integrations overview and connection details",
      fakes: ({ fake }) => ({ telegram: fake.telegram() }),
      setup: ({ given }) => [given.organization.exists({ id: orgId, slug: "ada", name: "Ada" })],
      steps: ({ when, then, runner }) => [
        when.codemode.run({
          scope,
          label: "connect an API, a signed webhook, and Telegram, and remove a legacy API",
          code: `async () => {
            const setup = (connectionId, input) => integrations.setup({ connectionId, kind: "input", input });
            await setup("api#billing", { baseUrl: "https://billing.example.com", type: "bearer", token: ${JSON.stringify(secrets.token)} });
            await setup("api#legacy", { baseUrl: "https://legacy.example.com", type: "none" });
            await integrations.disconnect({ connectionId: "api#legacy", confirm: "api#legacy" });
            await setup("webhook#acme", {
              name: "Acme",
              verification: { type: "none" },
              deliveryIdentity: { type: "header", name: "x-acme-delivery" },
              auth: {
                type: "hmac",
                secret: ${JSON.stringify(secrets.signing)},
                algorithm: "sha256",
                signature: { location: "header", name: "x-acme-signature", encoding: "hex" },
                signedPayload: { type: "rawBody" },
              },
            });
            await setup("backoffice#telegram", { botToken: ${JSON.stringify(secrets.telegram)}, botUsername: null });
          }`,
          assertToolCalls: ["integrations.setup", "integrations.disconnect"],
        }),
        when.codemode.run({
          scope,
          label: "an agent fires a connection event no source reported",
          code: `async () => await events.fire({ source: "integrations", eventType: "connection.ready", payload: { name: "Forged", authMethod: null } })`,
          assertToolCalls: ["events.fire"],
        }),
        runner.drain(),
        then.assert("the overview lists each connection's latest state and label", async (ctx) => {
          const replica = ctx.lofi.automations.forOrg(orgId);
          await replica.drain();
          // By service, then connection ID.
          const connections = await readAutomationReplica(
            replica.replica,
            "integrationConnections",
            undefined,
          );
          expect(
            connections.map((connection) => ({
              connectionId: connection.connectionId,
              kind: connection.kind,
              state: connection.state,
              name: connection.displayName,
              authMethod: connection.authMethod,
            })),
          ).toEqual([
            {
              connectionId: "api#billing",
              kind: "api",
              state: "ready",
              name: "billing",
              authMethod: "bearer",
            },
            // A disconnection carries no label, so the removed connection keeps its earlier one.
            // Its readiness was delivered after removal, so that label has only the address.
            {
              connectionId: "api#legacy",
              kind: "api",
              state: "disconnected",
              name: "legacy",
              authMethod: null,
            },
            {
              connectionId: "backoffice#telegram",
              kind: "native",
              state: "ready",
              name: "Telegram",
              authMethod: "api-key",
            },
            {
              connectionId: "webhook#acme",
              kind: "webhook",
              state: "ready",
              name: "Acme",
              authMethod: "signature",
            },
          ]);
        }),
        then.assert("each connection describes its own source without secrets", async (ctx) => {
          const described = {
            api: await describeConnection(ctx, "api#billing"),
            legacy: await describeConnection(ctx, "api#legacy"),
            webhook: await describeConnection(ctx, "webhook#acme"),
            telegram: await describeConnection(ctx, "backoffice#telegram"),
          };
          expect(described).toMatchObject({
            api: {
              connection: {
                name: "billing",
                authMethod: "bearer",
                authorization: { status: "available" },
              },
              details: {
                kind: "api",
                connection: { baseUrl: "https://billing.example.com" },
                authStatus: { mode: "bearer", credentials: "present" },
              },
            },
            legacy: {
              connection: { authMethod: null, configuration: { status: "missing" } },
              details: { kind: "api", connection: null, authStatus: null },
            },
            webhook: {
              connection: { name: "Acme", authMethod: "signature" },
              details: {
                kind: "webhook",
                endpoint: {
                  status: "active",
                  authConfig: { type: "hmac", algorithm: "sha256" },
                  deliveryIdentity: { type: "header", name: "x-acme-delivery" },
                  deliveries: { lastAcceptedAt: null, lastRejection: null },
                },
              },
            },
            telegram: {
              connection: { authMethod: "api-key", configuration: { status: "configured" } },
              details: { kind: "native" },
            },
          });
          const serialized = JSON.stringify(described);
          for (const secret of Object.values(secrets)) {
            expect(serialized).not.toContain(secret);
          }
        }),
        then.hooks.noFailed({ orgId, fragments: ["api", "automations"] }),
      ],
    }),
  );
});
