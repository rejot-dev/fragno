import { assert, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import {
  unavailableBackofficeAuthorityResolver,
  withBackofficeActorCapabilityGrants,
  type BackofficeAuthorityResolver,
} from "@/backoffice-runtime/authority-resolver";
import {
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioDefinitionInput,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { executeBackofficeRuntimeTool } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";

import { InMemoryReson8Object } from "../../../../../workers/reson8.do";
import {
  integrationListOutputSchema,
  integrationSetupProgressSchema,
} from "./integration-contracts";
import type { IntegrationContext } from "./integration-implementation";
import { createIntegrationRegistry } from "./integration-registry";
import { integrationsToolFamily } from "./integration-tools";
import { createReson8Integration } from "./reson8-integration";

const scope = { kind: "org", orgId: "reson8-org" } as const;
const connectionId = "backoffice#reson8";
const apiKey = "test-reson8-api-key";

async function runReson8IntegrationScenario<TVars extends Record<string, unknown>>(
  defineScenario: (provider: {
    reads: string[];
    transcriptions: { bytes: number[]; query: Record<string, string> }[];
    control: { readStatus: number; invalidTranscription: boolean };
  }) => BackofficeScenarioDefinitionInput<TVars>,
  receivingAuthorityResolver: BackofficeAuthorityResolver | null = null,
) {
  const reads: string[] = [];
  const transcriptions: { bytes: number[]; query: Record<string, string> }[] = [];
  const control = { readStatus: 200, invalidTranscription: false };
  const providerFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert(url.origin === "https://api.reson8.dev", "Unexpected Reson8 provider origin");
    if (request.headers.get("authorization") !== `ApiKey ${apiKey}`) {
      return Response.json(
        { code: "UNAUTHORIZED", message: "Rejected credentials" },
        { status: 401 },
      );
    }
    if (request.method === "GET" && url.pathname === "/v1/custom-model") {
      reads.push(url.pathname);
      return Response.json(
        control.readStatus === 200
          ? []
          : { code: "INTERNAL_ERROR", message: `Provider error containing ${apiKey}` },
        { status: control.readStatus },
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/speech-to-text/prerecorded") {
      assert(
        request.headers.get("content-type") === "application/octet-stream",
        "Unexpected Reson8 audio content type",
      );
      transcriptions.push({
        bytes: Array.from(new Uint8Array(await request.arrayBuffer())),
        query: Object.fromEntries(url.searchParams),
      });
      return Response.json(
        control.invalidTranscription
          ? { text: 123 }
          : {
              text: "Hello from Reson8",
              start_ms: 0,
              duration_ms: 500,
              words: [{ text: "Hello", start_ms: 0, confidence: 0.9 }],
            },
      );
    }
    throw new Error("Unexpected Reson8 provider request.");
  };
  const directory = await mkdtemp(path.join(tmpdir(), "backoffice-reson8-integration-"));
  try {
    const scenario = defineScenario({ reads, transcriptions, control });
    await runBackofficeScenario(
      defineBackofficeScenario({
        ...scenario,
        options: { ...scenario.options, sqliteDataDirectory: directory },
        objectOverrides: {
          ...scenario.objectOverrides,
          RESON8: (options) =>
            new InMemoryReson8Object({
              ...options,
              runtime: receivingAuthorityResolver
                ? { ...options.runtime, authorityResolver: receivingAuthorityResolver }
                : options.runtime,
              fetch: providerFetch,
            }),
        },
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createIntegrationScenarioTerminal(
  runtime: BackofficeRuntimeServices,
  execution: BackofficeExecutionContext,
  kernel: BackofficeKernel,
) {
  const context = createRouteBackedRuntimeContext({
    runtime,
    execution,
    kernel,
    billingOrganizationId: null,
  });
  assert(context.stateBackend);
  return createInteractiveBashHost({ context: { ...context, stateBackend: context.stateBackend } })
    .bash;
}

function createIntegrationScenarioContext(
  runtime: BackofficeRuntimeServices,
  execution: BackofficeExecutionContext,
): IntegrationContext {
  return { kernel: new BackofficeKernel(runtime), execution };
}

test("Codemode resolves deterministic Reson8 addresses across setup, requests, restart, and configuration removal", async () => {
  await runReson8IntegrationScenario((provider) => ({
    name: "Reson8 named setup and execution through the registered facade",
    setup: ({ given }) => [
      given.organization.exists({ id: scope.orgId, slug: "reson8", name: "Reson8" }),
    ],
    steps: ({ then, runner }) => [
      then.assert(
        "discovery exposes an unconfigured setup address without creating configuration or legacy lifecycle tools",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
          const removed = [];
          for (const name of ["connect", "continueSetup"]) {
            try { await integrations[name]({}); } catch (error) { removed.push(error.message); }
          }
          return { services: await integrations.discover(), page: await integrations.list({ cursor: null }), removed };
        }`,
            assertToolCalls: ["integrations.discover", "integrations.list"],
          });
          expect(run.result).toMatchObject({
            services: [
              { id: "api", setupTargets: [], availability: { status: "available" } },
              { id: "mcp", setupTargets: [], availability: { status: "available" } },
              {
                id: "reson8",
                setupTargets: [{ kind: "connection", connectionId }],
                availability: { status: "available" },
              },
            ],
            page: { connections: [], cursor: null },
            removed: [
              expect.stringContaining("Unknown tool"),
              expect.stringContaining("Unknown tool"),
            ],
          });
          const setup = await ctx.runCodemode({
            scope,
            code: `async () => await integrations.setup({ kind: "check", connectionId: "backoffice#reson8" })`,
            assertToolCalls: ["integrations.setup"],
          });
          const nullSubmission = await ctx.runCodemode({
            scope,
            code: `async () => {
              try { await integrations.setup({ kind: "input", connectionId: "backoffice#reson8", input: null }); }
              catch (error) { return { rejected: true }; }
              return { rejected: false };
            }`,
          });
          expect(nullSubmission.result).toEqual({ rejected: true });
          const requirements = integrationSetupProgressSchema.parse(setup.result);
          expect(requirements).toMatchObject({
            status: "needs-input",
            connectionId,
            secretFields: ["apiKey"],
            inputSchema: { type: "object" },
          });
          for (const field of ["setupId", "state", "binding", "reference", "scope"]) {
            expect(requirements).not.toHaveProperty(field);
          }
          expect(
            await ctx.runtime.objects.reson8.forOrg(scope.orgId).commands.getAdminConfig(),
          ).toEqual({ configured: false });
          expect(provider.reads).toEqual([]);
          expect(provider.transcriptions).toEqual([]);
        },
      ),
      runner.restartObject({ binding: "RESON8", scope }),
      then.assert(
        "setup derives requirements after restart and saves only in the existing service store",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
          const target = { connectionId: "backoffice#reson8" };
          const before = await integrations.setup({ ...target, kind: "check" });
          const ready = await integrations.setup({ ...target, kind: "input", input: { apiKey: ${JSON.stringify(apiKey)} } });
          const repeated = await integrations.setup({ ...target, kind: "input", input: { apiKey: "must-not-replace-existing-key" } });
          return { before, ready, repeated, page: await integrations.list({ cursor: null }) };
        }`,
          });
          expect(run.result).toMatchObject({
            before: { status: "needs-input", connectionId },
            ready: { status: "ready", connectionId },
            repeated: { status: "ready", connectionId },
            page: {
              connections: [
                {
                  connectionId,
                  integrationId: "reson8",
                  name: "Reson8",
                  configuration: { status: "configured" },
                },
              ],
              cursor: null,
            },
          });
          expect(JSON.stringify(run.result)).not.toContain(apiKey);
          expect(provider.reads).toEqual([]);
          expect(provider.transcriptions).toEqual([]);
        },
      ),
      then.assert(
        "actions execute real routes while inspection remains independent from live evidence",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
          const connectionId = "backoffice#reson8";
          const actions = await integrations.actions({ connectionId });
          const transcript = await integrations.execute({ connectionId, actionId: actions[0].id, input: { audio: { bytes: [0,127,255] }, query: null } });
          const checked = await integrations.verify({ connectionId });
          const inspected = await integrations.get({ connectionId });
          return { actions, transcript, checked, inspected };
        }`,
            assertToolCalls: [
              "integrations.actions",
              "integrations.execute",
              "integrations.verify",
              "integrations.get",
            ],
          });
          expect(run.result).toMatchObject({
            actions: [
              {
                id: "prerecorded.transcribe",
                inputSchema: { type: "object" },
                outputSchema: { type: "object" },
              },
            ],
            transcript: { text: "Hello from Reson8", duration_ms: 500 },
            checked: { connectionId, checks: [{ status: "passed" }] },
            inspected: { connectionId, checks: [{ status: "not-checked" }] },
          });
          expect(provider.reads).toEqual(["/v1/custom-model"]);
          expect(provider.transcriptions).toEqual([{ bytes: [0, 127, 255], query: {} }]);
        },
      ),
      runner.restartObject({ binding: "RESON8", scope }),
      then.assert(
        "the same address survives recreation without the standalone Reson8 tool runtime",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => ({
          inspected: await integrations.get({ connectionId: "backoffice#reson8" }),
          transcript: await integrations.execute({ connectionId: "backoffice#reson8", actionId: "prerecorded.transcribe", input: { audio: { bytes: [4,5] }, query: null } }),
        })`,
          });
          expect(run.result).toMatchObject({
            inspected: { connectionId, configuration: { status: "configured" } },
            transcript: { text: "Hello from Reson8" },
          });
          expect(provider.transcriptions.map((call) => call.bytes)).toEqual([
            [0, 127, 255],
            [4, 5],
          ]);
        },
      ),
      then.assert(
        "reconfiguration replaces the stored key, which verification then observes",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
          const target = { connectionId: "backoffice#reson8" };
          const check = await integrations.reconfigure({ ...target, kind: "check" });
          const rotated = await integrations.reconfigure({ ...target, kind: "input", input: { apiKey: "rotated-wrong-key" } });
          const rejected = await integrations.verify(target);
          const restored = await integrations.reconfigure({ ...target, kind: "input", input: { apiKey: ${JSON.stringify(apiKey)} } });
          return { check, rotated, rejected, restored, accepted: await integrations.verify(target) };
        }`,
            assertToolCalls: ["integrations.reconfigure", "integrations.verify"],
          });
          expect(run.result).toMatchObject({
            check: { status: "needs-input", connectionId, secretFields: ["apiKey"] },
            rotated: { status: "ready", connectionId },
            rejected: { checks: [{ status: "failed", message: expect.stringContaining("401") }] },
            restored: { status: "ready", connectionId },
            accepted: { checks: [{ status: "passed" }] },
          });
          expect(JSON.stringify(run.result)).not.toContain("rotated-wrong-key");
          expect(provider.reads).toHaveLength(2);
        },
      ),
      then.assert(
        "disconnecting changes listing, setup, and execution without invalidating the slot address",
        async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
          const target = { connectionId: "backoffice#reson8" };
          const disconnected = await integrations.disconnect({ ...target, confirm: target.connectionId });
          const repeated = await integrations.disconnect({ ...target, confirm: target.connectionId });
          const reconfigure = await integrations.reconfigure({ ...target, kind: "check" });
          const page = await integrations.list({ cursor: null });
          const inspected = await integrations.get(target);
          const setup = await integrations.setup({ ...target, kind: "check" });
          try { await integrations.execute({ ...target, actionId: "prerecorded.transcribe", input: { audio: { bytes: [6] }, query: null } }); }
          catch (error) { return { disconnected, repeated, reconfigure, page, inspected, setup, executionError: error.message }; }
          throw new Error("Unconfigured transcription unexpectedly succeeded");
        }`,
            assertToolCalls: ["integrations.disconnect", "integrations.reconfigure"],
          });
          expect(run.result).toMatchObject({
            disconnected: { connectionId, status: "disconnected" },
            repeated: { connectionId, status: "not-configured" },
            reconfigure: { status: "blocked", reason: expect.stringContaining("Run setup") },
            page: { connections: [], cursor: null },
            inspected: { configuration: { status: "missing" } },
            setup: { status: "needs-input", connectionId },
            executionError: expect.stringContaining("not configured"),
          });
          expect(
            await ctx.runtime.objects.reson8.forOrg(scope.orgId).commands.getAdminConfig(),
          ).toEqual({ configured: false });
          expect(provider.transcriptions).toHaveLength(2);
          expect(provider.reads).toHaveLength(2);
        },
      ),
    ],
  }));
});

test("terminal commands use scalar connection IDs without setup handles or persistent shell variables", async () => {
  await runReson8IntegrationScenario((provider) => ({
    name: "Reson8 deterministic terminal addresses",
    setup: ({ given }) => [
      given.organization.exists({ id: scope.orgId, slug: "reson8", name: "Reson8" }),
    ],
    steps: ({ then }) => [
      then.assert(
        "unconfigured discovery and setup work and every command has help",
        async (ctx) => {
          const bash = createIntegrationScenarioTerminal(
            ctx.runtime.services,
            createBackofficeSystemExecution(scope),
            new BackofficeKernel(ctx.runtime.services),
          );
          const discovery = await bash.exec("integrations.discover");
          expect(discovery.exitCode, discovery.stderr).toBe(0);
          expect(discovery.stdout).toContain("\n  {\n");
          expect(JSON.parse(discovery.stdout)).toMatchObject([
            { id: "api", setupTargets: [] },
            { id: "mcp", setupTargets: [] },
            { id: "reson8", setupTargets: [{ connectionId }] },
          ]);
          const page = await bash.exec("integrations.list --json");
          expect(page.exitCode, page.stderr).toBe(0);
          expect(JSON.parse(page.stdout)).toEqual({ connections: [], cursor: null });
          for (const command of [
            "integrations.discover",
            "integrations.list",
            "integrations.get",
            "integrations.setup",
            "integrations.reconfigure",
            "integrations.disconnect",
            "integrations.actions",
            "integrations.execute",
            "integrations.verify",
          ]) {
            const help = await bash.exec(`${command} --help`);
            expect(help.exitCode, help.stderr).toBe(0);
            expect(help.stdout).toContain(command);
            expect(help.stdout).toContain("--format");
          }
          const setup = await bash.exec(
            "integrations.setup --connection-id 'backoffice#reson8' --json",
          );
          expect(setup.exitCode, setup.stderr).toBe(0);
          expect(JSON.parse(setup.stdout)).toMatchObject({
            status: "needs-input",
            connectionId,
            secretFields: ["apiKey"],
          });
          expect(provider.reads).toEqual([]);
        },
      ),
      then.assert(
        "a fresh shell submits setup, lists a plain ID, and verifies real transcription",
        async (ctx) => {
          const bash = createIntegrationScenarioTerminal(
            ctx.runtime.services,
            createBackofficeSystemExecution(scope),
            new BackofficeKernel(ctx.runtime.services),
          );
          const setupCommand = "integrations.setup --connection-id 'backoffice#reson8'";
          for (const input of [
            "null",
            "false",
            "0",
            '"value"',
            "[]",
            '{"apiKey":" "}',
            '{"kind":"input","values":{"apiKey":"wrong-wrapper"}}',
          ]) {
            const invalid = await bash.exec(`${setupCommand} --input-json '${input}'`);
            expect(invalid).toMatchObject({ exitCode: 1 });
          }
          for (const option of ["--input-json", "--input-json ''", "--input-json not-json"]) {
            expect(await bash.exec(`${setupCommand} ${option}`)).toMatchObject({ exitCode: 1 });
          }
          expect(
            await bash.exec(`${setupCommand} --response-json '{"kind":"check"}'`),
          ).toMatchObject({
            exitCode: 1,
            stderr: expect.stringContaining("does not accept option --response-json"),
          });
          expect(
            await ctx.runtime.objects.reson8.forOrg(scope.orgId).commands.getAdminConfig(),
          ).toEqual({ configured: false });
          const requirements = await bash.exec(`${setupCommand} --json`);
          expect(requirements.exitCode, requirements.stderr).toBe(0);
          expect(JSON.parse(requirements.stdout)).toMatchObject({ status: "needs-input" });
          const setup = await bash.exec(
            `integrations.setup --connection-id 'backoffice#reson8' --input-json '${JSON.stringify({ apiKey })}' --format json`,
          );
          expect(setup.exitCode, setup.stderr).toBe(0);
          expect(JSON.parse(setup.stdout)).toEqual({ status: "ready", connectionId });
          expect(setup.stdout).not.toContain(apiKey);
          const repeated = await bash.exec(
            `integrations.setup --connection-id 'backoffice#reson8' --input-json '{"apiKey":"must-not-replace-existing-key"}' --json`,
          );
          expect(repeated.exitCode, repeated.stderr).toBe(0);
          expect(JSON.parse(repeated.stdout)).toEqual({ status: "ready", connectionId });
          const selected = await bash.exec("integrations.list --print connections.0.connectionId");
          expect(selected.exitCode, selected.stderr).toBe(0);
          assert(
            selected.stdout === "backoffice#reson8\n",
            "Connection selection must print a scalar ID",
          );
          const inspected = await bash.exec(
            'integrations.get --connection-id "$(integrations.list --print connections.0.connectionId)" --json',
          );
          expect(inspected.exitCode, inspected.stderr).toBe(0);
          expect(JSON.parse(inspected.stdout)).toMatchObject({
            connectionId,
            configuration: { status: "configured" },
            checks: [{ status: "not-checked" }],
          });
          const actions = await bash.exec(
            "integrations.actions --connection-id 'backoffice#reson8' --json",
          );
          expect(actions.exitCode, actions.stderr).toBe(0);
          expect(JSON.parse(actions.stdout)).toMatchObject([
            {
              id: "prerecorded.transcribe",
              inputSchema: { type: "object" },
              outputSchema: { type: "object" },
            },
          ]);
          const transcript = await bash.exec(
            `integrations.execute --connection-id 'backoffice#reson8' --action-id prerecorded.transcribe --input-json '{"audio":{"bytes":[0,127,255]},"query":null}' --print text`,
          );
          expect(transcript.exitCode, transcript.stderr).toBe(0);
          assert(
            transcript.stdout === "Hello from Reson8\n",
            "Terminal --print must return transcript text",
          );
          const checked = await bash.exec(
            "integrations.verify --connection-id 'backoffice#reson8' --json",
          );
          expect(checked.exitCode, checked.stderr).toBe(0);
          expect(JSON.parse(checked.stdout)).toMatchObject({
            connectionId,
            checks: [{ status: "passed" }],
          });
          const after = await bash.exec(
            "integrations.get --connection-id 'backoffice#reson8' --json",
          );
          expect(JSON.parse(after.stdout)).toMatchObject({ checks: [{ status: "not-checked" }] });
          expect(provider.reads).toEqual(["/v1/custom-model"]);
          expect(provider.transcriptions).toEqual([{ bytes: [0, 127, 255], query: {} }]);
        },
      ),
      then.assert(
        "invalid addresses, legacy options, malformed JSON, cursors, and action contracts stop before transport",
        async (ctx) => {
          const bash = createIntegrationScenarioTerminal(
            ctx.runtime.services,
            createBackofficeSystemExecution(scope),
            new BackofficeKernel(ctx.runtime.services),
          );
          const missing = await bash.exec("integrations.get");
          expect(missing).toMatchObject({
            exitCode: 1,
            stderr: expect.stringContaining("Missing required option --connection-id"),
          });
          for (const id of [
            "reson8",
            "unknown#reson8",
            "backoffice#unknown",
            "backoffice#reson8#other-org",
            "backoffice#reson8 ",
          ]) {
            expect(await bash.exec(`integrations.actions --connection-id '${id}'`)).toMatchObject({
              exitCode: 1,
            });
          }
          expect(await bash.exec("integrations.get --reference '{}'")).toMatchObject({
            exitCode: 1,
            stderr: expect.stringContaining("does not accept option --reference"),
          });
          expect(await bash.exec("integrations.list --adapter native")).toMatchObject({
            exitCode: 1,
            stderr: expect.stringContaining("does not accept option --adapter"),
          });
          expect(await bash.exec("integrations.list --cursor invalid")).toMatchObject({
            exitCode: 1,
            stderr: expect.stringContaining("cursor is invalid"),
          });
          const base = "integrations.execute --connection-id 'backoffice#reson8'";
          expect(await bash.exec(`${base} --action-id prerecorded.transcribe`)).toMatchObject({
            exitCode: 1,
            stderr: expect.stringContaining("Missing required option --input-json"),
          });
          expect(
            await bash.exec(`${base} --action-id prerecorded.transcribe --input-json not-json`),
          ).toMatchObject({
            exitCode: 1,
            stderr: expect.stringContaining("--input-json must be valid JSON"),
          });
          expect(
            await bash.exec(
              `${base} --action-id 'prerecorded.transcribe ' --input-json '{"audio":{"bytes":[1]},"query":null}'`,
            ),
          ).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("action not found") });
          for (const input of ["null", "false", "0", '"value"', "[]"]) {
            expect(
              await bash.exec(`${base} --action-id unknown --input-json '${input}'`),
            ).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("action not found") });
          }
          expect(
            await bash.exec(
              `${base} --action-id prerecorded.transcribe --input-json '{"audio":{"bytes":[256]},"query":null}'`,
            ),
          ).toMatchObject({ exitCode: 1 });
          expect(
            await bash.exec(
              `integrations.setup --connection-id 'backoffice#reson8' --input-json not-json`,
            ),
          ).toMatchObject({ exitCode: 1 });
          expect(provider.reads).toEqual(["/v1/custom-model"]);
          expect(provider.transcriptions).toEqual([{ bytes: [0, 127, 255], query: {} }]);
        },
      ),
    ],
  }));
});

test("connection IDs cannot select an owner or replace umbrella and service authority", async () => {
  await runReson8IntegrationScenario((provider) => ({
    name: "Integration permissions and current-scope address resolution",
    setup: ({ given }) => [
      given.auth.user({ id: "member", email: "member@example.test" }),
      given.auth.organization({
        id: scope.orgId,
        slug: "reson8",
        name: "Reson8",
        ownerUserId: "member",
      }),
      given.organization.exists({ id: "other-org", slug: "other-reson8", name: "Other Reson8" }),
    ],
    steps: ({ then }) => [
      then.assert(
        "setup requires umbrella management and native configuration-write authority",
        async (ctx) => {
          const execution = createBackofficeSystemExecution(scope);
          const kernel = new BackofficeKernel(ctx.runtime.services);
          const agent = createIntegrationScenarioTerminal(
            ctx.runtime.services,
            createBackofficeServiceExecution({
              scope,
              service: { type: "agent", id: "integration-setup-principal" },
            }),
            kernel,
          );
          expect(
            await agent.exec("integrations.setup --connection-id 'backoffice#reson8'"),
          ).toMatchObject({
            exitCode: 1,
            stderr: expect.stringContaining("Required permission: integrations.manage"),
          });
          const actor = {
            scope: "internal",
            type: "agent",
            id: "integration-setup-agent",
            role: "assistant",
          } as const;
          const limitedKernel = new BackofficeKernel({
            ...ctx.runtime.services,
            authorityResolver: withBackofficeActorCapabilityGrants({
              resolver: ctx.runtime.services.authorityResolver,
              actor,
              grants: [
                BACKOFFICE_PERMISSION.integrations.manage,
                BACKOFFICE_PERMISSION.connections.read,
                BACKOFFICE_PERMISSION.upload.read,
              ],
            }),
          });
          const limited = createIntegrationScenarioTerminal(
            ctx.runtime.services,
            { ...execution, actors: { ...execution.actors, delegation: [actor] } },
            limitedKernel,
          );
          expect(
            await limited.exec(
              `integrations.setup --connection-id 'backoffice#reson8' --input-json '${JSON.stringify({ apiKey })}'`,
            ),
          ).toMatchObject({
            exitCode: 1,
            stderr: expect.stringContaining("required capability grant"),
          });
          expect(
            await ctx.runtime.objects.reson8.forOrg(scope.orgId).commands.getAdminConfig(),
          ).toEqual({ configured: false });
          const bash = createIntegrationScenarioTerminal(ctx.runtime.services, execution, kernel);
          const saved = await bash.exec(
            `integrations.setup --connection-id 'backoffice#reson8' --input-json '${JSON.stringify({ apiKey })}' --json`,
          );
          expect(saved.exitCode, saved.stderr).toBe(0);
          expect(JSON.parse(saved.stdout)).toEqual({ status: "ready", connectionId });
          expect(provider.transcriptions).toEqual([]);
        },
      ),
      then.assert(
        "an address copied into another scope uses only that scope's configuration and cannot smuggle an owner",
        async (ctx) => {
          const kernel = new BackofficeKernel(ctx.runtime.services);
          const other = createIntegrationScenarioTerminal(
            ctx.runtime.services,
            createBackofficeSystemExecution({ kind: "org", orgId: "other-org" }),
            kernel,
          );
          const inspected = await other.exec(
            "integrations.get --connection-id 'backoffice#reson8' --json",
          );
          expect(inspected.exitCode, inspected.stderr).toBe(0);
          expect(JSON.parse(inspected.stdout)).toMatchObject({
            connectionId,
            configuration: { status: "missing" },
          });
          const checked = await other.exec(
            "integrations.verify --connection-id 'backoffice#reson8' --json",
          );
          expect(checked.exitCode, checked.stderr).toBe(0);
          expect(JSON.parse(checked.stdout)).toMatchObject({ checks: [{ status: "not-checked" }] });
          expect(
            await other.exec(
              `integrations.execute --connection-id 'backoffice#reson8' --action-id prerecorded.transcribe --input-json '{"audio":{"bytes":[1]},"query":null}'`,
            ),
          ).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("not configured") });
          const host = createRouteBackedRuntimeContext({
            runtime: ctx.runtime.services,
            kernel,
            execution: createBackofficeSystemExecution(scope),
            billingOrganizationId: null,
          });
          const tool = integrationsToolFamily.tools.find(
            (candidate) => candidate.id === "integrations.execute",
          );
          assert(tool);
          await expect(
            executeBackofficeRuntimeTool(
              tool,
              {
                connectionId,
                scope: { kind: "org", orgId: "other-org" },
                actionId: "prerecorded.transcribe",
                input: { audio: { bytes: [1] }, query: null },
              },
              createBackofficeToolContext(host),
            ),
          ).rejects.toThrow();
          const userHost = host.createBackofficeScopedContext({ kind: "user", userId: "member" });
          assert(userHost.integrations);
          expect(await userHost.integrations.runtime.discover()).toMatchObject([
            { id: "api", availability: { status: "available" } },
            { id: "mcp", availability: { status: "available" } },
            { id: "reson8", availability: { status: "unavailable" } },
          ]);
          expect(await userHost.integrations.runtime.list({ cursor: null })).toEqual({
            connections: [],
            cursor: null,
          });
          expect(
            await userHost.integrations.runtime.setup({
              kind: "check",
              connectionId,
            }),
          ).toMatchObject({ status: "blocked" });
          await expect(userHost.integrations.runtime.get({ connectionId })).rejects.toThrow(
            "organization scope",
          );
          expect(
            await ctx.runtime.objects.reson8.forOrg("other-org").commands.getAdminConfig(),
          ).toEqual({ configured: false });
          expect(provider.reads).toEqual([]);
          expect(provider.transcriptions).toEqual([]);
        },
      ),
      then.assert(
        "umbrella execution alone does not grant native use and agents do not hold umbrella execution",
        async (ctx) => {
          const actor = {
            scope: "internal",
            type: "agent",
            id: "integration-agent",
            role: "assistant",
          } as const;
          const kernel = new BackofficeKernel({
            ...ctx.runtime.services,
            authorityResolver: withBackofficeActorCapabilityGrants({
              resolver: ctx.runtime.services.authorityResolver,
              actor,
              grants: [
                BACKOFFICE_PERMISSION.integrations.execute,
                BACKOFFICE_PERMISSION.upload.read,
              ],
            }),
          });
          const execution = createBackofficeSystemExecution(scope);
          const limited = createIntegrationScenarioTerminal(
            ctx.runtime.services,
            { ...execution, actors: { ...execution.actors, delegation: [actor] } },
            kernel,
          );
          const command = `integrations.execute --connection-id 'backoffice#reson8' --action-id prerecorded.transcribe --input-json '{"audio":{"bytes":[1]},"query":null}'`;
          expect(await limited.exec(command)).toMatchObject({
            exitCode: 1,
            stderr: expect.stringContaining("required capability grant"),
          });
          const agent = createIntegrationScenarioTerminal(
            ctx.runtime.services,
            createBackofficeServiceExecution({
              scope,
              service: { type: "agent", id: "integration-principal" },
            }),
            new BackofficeKernel(ctx.runtime.services),
          );
          expect(await agent.exec(command)).toMatchObject({
            exitCode: 1,
            stderr: expect.stringContaining("Required permission: integrations.execute"),
          });
          expect(provider.transcriptions).toEqual([]);
        },
      ),
      then.assert(
        "authorized actions do not acquire a configuration-inspection permission requirement",
        async (ctx) => {
          const actor = {
            scope: "internal",
            type: "capability",
            id: "integration-use-capability",
            role: "assistant",
          } as const;
          const kernel = new BackofficeKernel({
            ...ctx.runtime.services,
            authorityResolver: withBackofficeActorCapabilityGrants({
              resolver: ctx.runtime.services.authorityResolver,
              actor,
              grants: [
                BACKOFFICE_PERMISSION.integrations.read,
                BACKOFFICE_PERMISSION.integrations.execute,
                BACKOFFICE_PERMISSION.reson8.use,
                BACKOFFICE_PERMISSION.upload.read,
              ],
            }),
          });
          const execution = createBackofficeSystemExecution(scope);
          const bash = createIntegrationScenarioTerminal(
            ctx.runtime.services,
            { ...execution, actors: { ...execution.actors, delegation: [actor] } },
            kernel,
          );
          const transcript = await bash.exec(
            `integrations.execute --connection-id 'backoffice#reson8' --action-id prerecorded.transcribe --input-json '{"audio":{"bytes":[2]},"query":null}' --print text`,
          );
          expect(transcript.exitCode, transcript.stderr).toBe(0);
          assert(
            transcript.stdout === "Hello from Reson8\n",
            "Service-use authority should permit transcription without configuration-read authority",
          );
          expect(
            await bash.exec("integrations.get --connection-id 'backoffice#reson8'"),
          ).toMatchObject({
            exitCode: 1,
            stderr: expect.stringContaining("required capability grant"),
          });
          expect(provider.transcriptions).toEqual([{ bytes: [2], query: {} }]);
        },
      ),
    ],
  }));
});

test.each([
  { reason: "actor-capability-denied", receivingAuthorityResolver: null },
  {
    reason: "authority-unavailable",
    receivingAuthorityResolver: unavailableBackofficeAuthorityResolver,
  },
])(
  "verification propagates receiving-object $reason instead of reporting provider health",
  async ({ reason, receivingAuthorityResolver }) => {
    await runReson8IntegrationScenario(
      (provider) => ({
        name: "Receiving-object authorization remains a verification failure boundary",
        setup: ({ given }) => [
          given.organization.exists({ id: scope.orgId, slug: "reson8", name: "Reson8" }),
        ],
        steps: ({ then }) => [
          then.assert(
            "configure the existing source without contacting the provider",
            async (ctx) => {
              const setup = await ctx.runCodemode({
                scope,
                code: `async () => await integrations.setup({ kind: "input", connectionId: "backoffice#reson8", input: { apiKey: ${JSON.stringify(apiKey)} } })`,
              });
              expect(setup.result).toEqual({ status: "ready", connectionId });
              expect(provider.reads).toEqual([]);
            },
          ),
          then.assert(
            "caller authority cannot turn a receiving denial into service evidence",
            async (ctx) => {
              const actor = {
                scope: "internal",
                type: "agent",
                id: "verification-caller-agent",
                role: "assistant",
              } as const;
              const systemExecution = createBackofficeSystemExecution(scope);
              const execution = {
                ...systemExecution,
                actors: { ...systemExecution.actors, delegation: [actor] },
              };
              const kernel = new BackofficeKernel({
                ...ctx.runtime.services,
                authorityResolver: withBackofficeActorCapabilityGrants({
                  resolver: ctx.runtime.services.authorityResolver,
                  actor,
                  grants: [
                    BACKOFFICE_PERMISSION.integrations.manage,
                    BACKOFFICE_PERMISSION.connections.read,
                    BACKOFFICE_PERMISSION.reson8.use,
                    BACKOFFICE_PERMISSION.upload.read,
                  ],
                }),
              });
              const host = createRouteBackedRuntimeContext({
                runtime: ctx.runtime.services,
                kernel,
                execution,
                billingOrganizationId: null,
              });
              const verify = integrationsToolFamily.tools.find(
                (tool) => tool.id === "integrations.verify",
              );
              assert(verify);
              await expect(
                executeBackofficeRuntimeTool(
                  verify,
                  { connectionId },
                  createBackofficeToolContext(host),
                ),
              ).rejects.toMatchObject({
                name: "BackofficeForbiddenError",
                reason,
              });
              const bash = createIntegrationScenarioTerminal(
                ctx.runtime.services,
                execution,
                kernel,
              );
              const checked = await bash.exec(
                "integrations.verify --connection-id 'backoffice#reson8' --json",
              );
              expect(checked).toMatchObject({
                exitCode: 1,
                stdout: "",
                stderr: expect.stringContaining(
                  reason === "authority-unavailable"
                    ? "authority resolution is unavailable"
                    : "required capability grant",
                ),
              });
              expect(provider.reads).toEqual([]);
              expect(provider.transcriptions).toEqual([]);
              expect(
                await ctx.runtime.objects.reson8.forOrg(scope.orgId).commands.getAdminConfig(),
              ).toMatchObject({ configured: true });
            },
          ),
        ],
      }),
      receivingAuthorityResolver,
    );
  },
);

test("resolved Reson8 operations bind authority and validate binary contracts and live results", async () => {
  await runReson8IntegrationScenario((provider) => ({
    name: "Concrete Reson8 source contracts and request-bound authority",
    setup: ({ given }) => [
      given.auth.user({ id: "member", email: "member@example.test" }),
      given.auth.organization({
        id: scope.orgId,
        slug: "reson8",
        name: "Reson8",
        ownerUserId: "member",
      }),
    ],
    steps: ({ then }) => [
      then.assert(
        "native configuration authority does not authorize the resolved member's action handlers",
        async (ctx) => {
          const source = createReson8Integration({
            runtime: ctx.runtime.services,
            nowEpochMs: ctx.runtime.now,
          });
          // Members hold every non-administration permission, so a delegate narrows them to
          // configuration authority.
          const actor = {
            scope: "internal",
            type: "agent",
            id: "reson8-configuration-agent",
            role: "assistant",
          } as const;
          const member = createBackofficeUserExecution({ scope, userId: "member" });
          const context: IntegrationContext = {
            kernel: new BackofficeKernel({
              ...ctx.runtime.services,
              authorityResolver: withBackofficeActorCapabilityGrants({
                resolver: ctx.runtime.services.authorityResolver,
                actor,
                grants: [
                  BACKOFFICE_PERMISSION.connections.manage,
                  BACKOFFICE_PERMISSION.connections.read,
                ],
              }),
            }),
            execution: { ...member, actors: { ...member.actors, delegation: [actor] } },
          };
          assert(source.setup.kind === "supported");
          expect(
            await source.setup.run(context, {
              localId: "reson8",
              operation: { kind: "input", input: { apiKey } },
            }),
          ).toEqual({ status: "ready", connectionId });
          const resolved = await source.resolve(context, "reson8");
          const [action] = await resolved.actions();
          assert(action);
          await expect(action.invoke({ audio: { bytes: [1] }, query: null })).rejects.toMatchObject(
            { name: "BackofficeForbiddenError", reason: "actor-capability-denied" },
          );
          await expect(resolved.verify()).rejects.toMatchObject({
            name: "BackofficeForbiddenError",
            reason: "actor-capability-denied",
          });
          expect(provider.reads).toEqual([]);
          expect(provider.transcriptions).toEqual([]);
        },
      ),
      then.assert(
        "the published byte-array schema matches real route bytes, defaults, and explicit false query values",
        async (ctx) => {
          const source = createReson8Integration({
            runtime: ctx.runtime.services,
            nowEpochMs: ctx.runtime.now,
          });
          const resolved = await source.resolve(
            createIntegrationScenarioContext(
              ctx.runtime.services,
              createBackofficeSystemExecution(scope),
            ),
            "reson8",
          );
          const [action] = await resolved.actions();
          assert(action);
          expect(action.definition.inputSchema).toMatchObject({
            properties: {
              audio: {
                properties: { bytes: { items: { type: "integer", minimum: 0, maximum: 255 } } },
              },
            },
          });
          await expect(action.invoke({ audio: { bytes: [256] }, query: null })).rejects.toThrow();
          expect(provider.transcriptions).toEqual([]);
          const transcript = await action.invoke({
            audio: { bytes: [0, 127, 255] },
            query: {
              encoding: "pcm_s16le",
              sample_rate: 16000,
              channels: 1,
              custom_model_id: null,
              include_timestamps: true,
              include_words: true,
              include_confidence: false,
            },
          });
          expect(transcript).toEqual({
            text: "Hello from Reson8",
            start_ms: 0,
            duration_ms: 500,
            words: [{ text: "Hello", start_ms: 0, confidence: 0.9 }],
          });
          expect(provider.transcriptions).toEqual([
            {
              bytes: [0, 127, 255],
              query: {
                encoding: "pcm_s16le",
                sample_rate: "16000",
                channels: "1",
                include_timestamps: "true",
                include_words: "true",
                include_confidence: "false",
              },
            },
          ]);
        },
      ),
      then.assert(
        "read-only verification records real timestamps but neither retains evidence nor discloses provider echoes",
        async (ctx) => {
          const checkedAt = ctx.runtime.now();
          const source = createReson8Integration({
            runtime: ctx.runtime.services,
            nowEpochMs: () => checkedAt,
          });
          const resolved = await source.resolve(
            createIntegrationScenarioContext(
              ctx.runtime.services,
              createBackofficeSystemExecution(scope),
            ),
            "reson8",
          );
          for (const status of [401, 403, 500, 503]) {
            provider.control.readStatus = status;
            const result = await resolved.verify();
            expect(result).toMatchObject({
              configuration: { status: "configured" },
              authorization: { status: "available" },
              checks: [{ status: "failed", checkedAt: new Date(checkedAt).toISOString() }],
            });
            expect(JSON.stringify(result)).not.toContain(apiKey);
          }
          provider.control.readStatus = 200;
          expect(await resolved.verify()).toMatchObject({
            checks: [{ status: "passed", checkedAt: new Date(checkedAt).toISOString() }],
          });
          expect(await resolved.inspect()).toMatchObject({ checks: [{ status: "not-checked" }] });
          expect(provider.reads).toHaveLength(5);
          expect(provider.transcriptions).toHaveLength(1);
        },
      ),
      then.assert(
        "unvalidated provider results cannot cross the published output contract",
        async (ctx) => {
          const source = createReson8Integration({
            runtime: ctx.runtime.services,
            nowEpochMs: ctx.runtime.now,
          });
          const resolved = await source.resolve(
            createIntegrationScenarioContext(
              ctx.runtime.services,
              createBackofficeSystemExecution(scope),
            ),
            "reson8",
          );
          const [action] = await resolved.actions();
          assert(action);
          provider.control.invalidTranscription = true;
          await expect(action.invoke({ audio: { bytes: [7] }, query: null })).rejects.toThrow();
          provider.control.invalidTranscription = false;
          expect(await action.invoke({ audio: { bytes: [8] }, query: null })).toMatchObject({
            text: "Hello from Reson8",
          });
          expect(provider.transcriptions.map((call) => call.bytes)).toEqual([
            [0, 127, 255],
            [7],
            [8],
          ]);
          expect(
            await ctx.runtime.objects.reson8.forOrg(scope.orgId).commands.getAdminConfig(),
          ).toMatchObject({ configured: true });
        },
      ),
    ],
  }));
});

test("implementation claims reject collisions and wrong publication instead of shadowing source-owned configuration", async () => {
  await runReson8IntegrationScenario((provider) => ({
    name: "Connection address ownership through concrete Reson8 registration",
    setup: ({ given }) => [
      given.organization.exists({ id: scope.orgId, slug: "reson8", name: "Reson8" }),
    ],
    steps: ({ then }) => [
      then.assert(
        "ambiguous registrations fail before any setup or provider operation",
        async (ctx) => {
          const source = createReson8Integration({
            runtime: ctx.runtime.services,
            nowEpochMs: ctx.runtime.now,
          });
          const namespaceOwner = {
            ...source,
            connectionIds: [{ kind: "namespace", namespace: "backoffice" }] as const,
          };
          expect(() => createIntegrationRegistry([source, source])).toThrow("duplicate exact");
          expect(() => createIntegrationRegistry([namespaceOwner, namespaceOwner])).toThrow(
            "duplicate connection namespace",
          );
          expect(() => createIntegrationRegistry([source, namespaceOwner])).toThrow(
            "overlapping exact and namespace",
          );
          expect(() => createIntegrationRegistry([namespaceOwner, source])).toThrow(
            "overlapping exact and namespace",
          );
          expect(() => createIntegrationRegistry([{ ...source, connectionIds: [] }])).toThrow(
            "requires a connection ID claim",
          );
          expect(() =>
            createIntegrationRegistry([
              { ...source, connectionIds: [{ kind: "namespace", namespace: "api#nested" }] },
            ]),
          ).toThrow("invalid connection namespace");
          expect(
            await ctx.runtime.objects.reson8.forOrg(scope.orgId).commands.getAdminConfig(),
          ).toEqual({ configured: false });
          expect(provider.reads).toEqual([]);
          expect(provider.transcriptions).toEqual([]);
        },
      ),
      then.assert(
        "namespace ownership resolves the existing source and never normalizes or drops the suffix",
        async (ctx) => {
          const source = createReson8Integration({
            runtime: ctx.runtime.services,
            nowEpochMs: ctx.runtime.now,
          });
          const registry = createIntegrationRegistry([
            { ...source, connectionIds: [{ kind: "namespace", namespace: "backoffice" }] },
          ]);
          const context = createIntegrationScenarioContext(
            ctx.runtime.services,
            createBackofficeSystemExecution(scope),
          );
          expect(
            await registry.setup(context, {
              connectionId,
              kind: "input",
              input: { apiKey },
            }),
          ).toEqual({ status: "ready", connectionId });
          const page = integrationListOutputSchema.parse(await registry.list(context, null));
          expect(page.connections).toMatchObject([
            { connectionId, configuration: { status: "configured" } },
          ]);
          expect(page.cursor).toBeNull();
          await expect(registry.resolve(context, "backoffice#RESON8")).rejects.toThrow(
            "connection not found",
          );
          await expect(registry.resolve(context, "backoffice#reson8#other-org")).rejects.toThrow(
            "connection not found",
          );
          await expect(
            registry.list(context, JSON.stringify({ source: "unknown#", cursor: null })),
          ).rejects.toThrow("cursor is invalid");
          await expect(
            registry.list(context, JSON.stringify({ source: "backoffice#", cursor: "unknown" })),
          ).rejects.toThrow("cursor is invalid");
          const resolved = await registry.resolve(context, connectionId);
          const [action] = await resolved.actions();
          assert(action);
          expect(await action.invoke({ audio: { bytes: [13] }, query: null })).toMatchObject({
            text: "Hello from Reson8",
          });
          expect(provider.transcriptions).toEqual([{ bytes: [13], query: {} }]);
        },
      ),
      then.assert(
        "source pagination and explicit setup support do not create or reset connection state",
        async (ctx) => {
          const source = createReson8Integration({
            runtime: ctx.runtime.services,
            nowEpochMs: ctx.runtime.now,
          });
          const disabled = createReson8Integration({
            runtime: {
              objects: ctx.runtime.services.objects,
              config: {
                ...ctx.runtime.services.config,
                bindings: { ...ctx.runtime.services.config.bindings, reson8: false },
              },
            },
            nowEpochMs: ctx.runtime.now,
          });
          const registry = createIntegrationRegistry([
            source,
            { ...disabled, connectionIds: [{ kind: "namespace", namespace: "disabled" }] },
          ]);
          const context = createIntegrationScenarioContext(
            ctx.runtime.services,
            createBackofficeSystemExecution(scope),
          );
          // A finished source does not end the page; the empty disabled source adds nothing.
          expect(await registry.list(context, null)).toMatchObject({
            connections: [{ connectionId }],
            cursor: null,
          });
          const unsupported = createIntegrationRegistry([
            {
              ...source,
              setup: {
                kind: "unsupported",
                reason: "Integration setup is disabled for this deployment.",
              },
            },
          ]);
          const before = await ctx.runtime.objects.reson8
            .forOrg(scope.orgId)
            .commands.getAdminConfig();
          await expect(
            unsupported.setup(context, {
              connectionId,
              kind: "input",
              input: { apiKey: "must-not-replace-existing-key" },
            }),
          ).rejects.toThrow("setup is disabled");
          expect(
            await ctx.runtime.objects.reson8.forOrg(scope.orgId).commands.getAdminConfig(),
          ).toEqual(before);
          expect(provider.reads).toEqual([]);
          expect(provider.transcriptions).toHaveLength(1);
        },
      ),
      then.assert("a source cannot publish an address owned by another namespace", async (ctx) => {
        const source = createReson8Integration({
          runtime: ctx.runtime.services,
          nowEpochMs: ctx.runtime.now,
        });
        const registry = createIntegrationRegistry([
          { ...source, connectionIds: [{ kind: "namespace", namespace: "api" }] },
        ]);
        const context = createIntegrationScenarioContext(
          ctx.runtime.services,
          createBackofficeSystemExecution(scope),
        );
        await expect(registry.list(context, null)).rejects.toThrow(
          "published a connection ID it does not own",
        );
        await expect(registry.resolve(context, "api#reson8")).rejects.toThrow(
          "resolved a different connection ID",
        );
        await expect(
          registry.setup(context, { connectionId: "api#reson8", kind: "check" }),
        ).rejects.toThrow("setup for a different connection ID");
        expect(
          await ctx.runtime.objects.reson8.forOrg(scope.orgId).commands.getAdminConfig(),
        ).toMatchObject({ configured: true });
        expect(provider.reads).toEqual([]);
        expect(provider.transcriptions).toHaveLength(1);
      }),
    ],
  }));
});
