import { expect, test, vi } from "vitest";

import { eq, queryOnce } from "@tanstack/react-db";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { INTEGRATIONS_EVENT_SOURCE } from "@/fragno/runtime-tools/families/integrations/integration-events";
import { createIntegrationsRuntime } from "@/fragno/runtime-tools/families/integrations/integrations-runtime";

import { InMemoryApiObject } from "../../../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../workers/automations.do";
import { InMemoryBillingObject } from "../../../../workers/billing.do";
import { InMemoryCodemodeObject } from "../../../../workers/codemode.do";
import { InMemoryFormsObject } from "../../../../workers/forms.do";
import { InMemoryGitHubWebhookRouterObject } from "../../../../workers/github-webhook-router.do";
import { InMemoryGitHubObject } from "../../../../workers/github.do";
import { InMemoryMcpObject } from "../../../../workers/mcp.do";
import { InMemoryOtpObject } from "../../../../workers/otp.do";
import { InMemoryProjectConnectorObject } from "../../../../workers/project-connector.do";
import { InMemoryResendObject } from "../../../../workers/resend.do";
import { InMemoryReson8Object } from "../../../../workers/reson8.do";
import { InMemoryTelegramObject } from "../../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../../workers/upload.do";
import { integrationConnectionName } from "./connection-display";
import {
  currentIntegrationConnections,
  integrationConnectionStateChanges,
} from "./connection-overview";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  BILLING: (input) => new InMemoryBillingObject(input),
  CODEMODE: (input) => new InMemoryCodemodeObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  GITHUB: (input) => new InMemoryGitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new InMemoryGitHubWebhookRouterObject(input),
  MCP: (input) => new InMemoryMcpObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  PROJECT_CONNECTOR: (input) => new InMemoryProjectConnectorObject(input),
  RESEND: (input) => new InMemoryResendObject(input),
  RESON8: (input) => new InMemoryReson8Object(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const orgId = "integrations-org";
const scope = { kind: "org", orgId } as const;
const secrets = {
  token: "scenario-billing-token",
  signing: "scenario-signing-secret",
  reson8: "scenario-reson8-key",
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
      setup: ({ given }) => [given.organization.exists({ id: orgId, slug: "ada", name: "Ada" })],
      steps: ({ when, then, runner }) => [
        when.codemode.run({
          scope,
          label: "connect an API, a signed webhook, and Reson8, and remove a legacy API",
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
            await setup("backoffice#reson8", { apiKey: ${JSON.stringify(secrets.reson8)} });
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
          const database = ctx.tanstack.automations.forOrg(orgId);
          await database.drain();
          const events = await queryOnce((query) =>
            query
              .from({ event: database.collections.events })
              .where(({ event }) => eq(event.source, INTEGRATIONS_EVENT_SOURCE)),
          );
          // Deployed sources recorded events like this one before state events carried labels.
          const recordedBeforeLabels = {
            id: "recorded-before-labels",
            source: INTEGRATIONS_EVENT_SOURCE,
            eventType: "connection.ready",
            payload: {},
            subject: { scope, orgId, service: "mcp", connectionId: "mcp#before-labels" },
            occurredAt: new Date("2026-01-01T00:00:00.000Z"),
          };
          const connections = currentIntegrationConnections(
            integrationConnectionStateChanges([...events, recordedBeforeLabels]),
          );
          expect(
            connections.map((connection) => ({
              connectionId: connection.connectionId,
              kind: connection.kind,
              state: connection.state,
              name: integrationConnectionName(connection),
              authMethod: connection.label?.authMethod ?? null,
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
            // Unlabeled events fall back to the address until a backfill records a label.
            {
              connectionId: "mcp#before-labels",
              kind: "mcp",
              state: "ready",
              name: "before-labels",
              authMethod: null,
            },
            {
              connectionId: "backoffice#reson8",
              kind: "native",
              state: "ready",
              name: "Reson8",
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
            reson8: await describeConnection(ctx, "backoffice#reson8"),
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
            reson8: {
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
