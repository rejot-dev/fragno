import { assert, expect, test } from "vitest";

import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import { defineExtension } from "@earendil-works/pi-durable";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import {
  createBackofficeServiceExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createCodemodeTool } from "@/fragno/pi/extensions/backoffice/codemode-tool";

import { ApiObject } from "../../../../../workers/api-object";
import { createScriptedPiAgentDependencies } from "../../../../../workers/pi-durable-scenario.test-support";
import { PiObject } from "../../../../../workers/pi-object";

const PI_SCENARIO_AVAILABLE_MODELS = [
  {
    provider: "faux",
    modelId: "faux-1",
    label: "Faux 1",
    contextWindow: 128_000,
    thinkingLevels: ["off"],
  },
] as const;

const alice = { kind: "user", userId: "alice", jurisdiction: null } as const;
const providerOrigin = "https://gifs.provider.test";
const target = { connectionId: "api#gifs" };
const knownInput = {
  baseUrl: providerOrigin,
  type: "apiKey",
  location: "query",
  parameter: "api_key",
};
const keySecret = {
  field: "key",
  label: "GIFs API key",
  description: "Create one on the GIFs developer dashboard: https://gifs.provider.test/dashboard",
};

/** The agent asks for the key with one codemode call, then ends its turn. */
function agentAskingForTheKey(requests: string[]): LocalBackofficeObjects {
  return {
    PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) => {
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: `async () => await integrations.requestInput(${JSON.stringify({
                ...target,
                operation: "setup",
                input: knownInput,
                title: "Connect GIFs",
                secrets: [keySecret],
              })})`,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxText("The form asks for your GIFs key.")]),
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      return new PiObject({
        state,
        runtime,
        dependencies: {
          ...createScriptedPiAgentDependencies(models),
          extensions: (_config, agent) => [
            defineExtension({ name: "scenario", tools: [createCodemodeTool(agent)] }),
          ],
        },
        openStorage: openPiSessionStore,
        idFromConfig: piAgentIdFromConfig,
        nowEpochMs,
      });
    },
    API: (options) =>
      new ApiObject({
        ...options,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request.url);
          return Response.json({ data: [] });
        },
      }),
  };
}

async function promptAgent(ctx: BackofficeScenarioContext) {
  const execution = createBackofficeUserExecution({ scope: alice, userId: "alice" });
  const submitted = await ctx.runtime.objects.piManager.for(alice).http.fetchAuthorized(
    new Request("https://pi-manager.test/api/pi-manager/agents/assistant/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "connect-gifs", content: "Connect GIFs." }),
    }),
    { execution, propagationContext: null },
  );
  assert.equal(submitted.status, 202, await submitted.clone().text());
}

async function agentConversation(scope: BackofficeContextScope, ctx: BackofficeScenarioContext) {
  const response = await ctx.runtime.objects.piManager
    .for(scope)
    .http.fetchAuthorized(
      new Request("https://pi-manager.test/api/pi-manager/agents/assistant/view"),
      {
        execution: createBackofficeServiceExecution({
          scope,
          service: { type: "automation", id: "request-input-scenario" },
        }),
      },
    );
  assert.equal(response.status, 200, await response.clone().text());
  return await response.text();
}

test("an agent collects a connection's key in a form card, and the key reaches only the provider", async () => {
  const requests: string[] = [];
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "integrations.requestInput collects secrets outside the conversation",
      objects: { ...allLocalObjects, ...agentAskingForTheKey(requests) },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      // The form is a static workflow, read from the product's files.
      files: backofficeFiles.systemOnly(),
      vars: () => ({ instanceId: "", waitingFor: "" }),
      setup: ({ given }) => [given.auth.user({ id: "alice" })],
      steps: ({ then }) => [
        then.assert(
          "a request names only secret fields, and keeps secrets out of input",
          async (ctx) => {
            const run = await ctx.runCodemode({
              scope: alice,
              code: `async () => {
              const request = ${JSON.stringify({ ...target, operation: "setup", title: "Connect GIFs" })};
              const attempt = (extra) => integrations.requestInput({ ...request, ...extra }).then(
                () => "accepted",
                (error) => error.message,
              );
              return {
                notSecret: await attempt({ input: ${JSON.stringify(knownInput)}, secrets: [{ ...${JSON.stringify(keySecret)}, field: "baseUrl" }] }),
                keyInInput: await attempt({ input: { ...${JSON.stringify(knownInput)}, key: "from-chat" }, secrets: [${JSON.stringify(keySecret)}] }),
              };
            }`,
            });
            expect(run.result).toEqual({
              notSecret: expect.stringContaining("baseUrl is not a secret field of api#gifs"),
              keyInInput: expect.stringContaining("leave it out of input"),
            });
          },
        ),
        then.assert("the agent's request shows a form waiting for the key", async (ctx) => {
          await promptAgent(ctx);
          await ctx.runtime.drain();
          // The agent's call returns the form's run, which waits for the user.
          const [toolResult] = JSON.parse(await agentConversation(alice, ctx))
            .entries.flatMap(
              (entry: { model?: { role: string; content: { text: string }[] }[] }) =>
                entry.model ?? [],
            )
            .filter((message: { role: string }) => message.role === "toolResult");
          const { instanceId } = JSON.parse(toolResult.content[0].text) as { instanceId: string };
          const read = await ctx.runCodemode({
            scope: alice,
            code: `async () => await workflow.getInstance({ instanceId: ${JSON.stringify(instanceId)} })`,
          });
          const instance = read.result as {
            id: string;
            details: { status: string };
            meta: { name: string };
            waitingFor: string[];
          };
          assert(instance.meta.name === "integration-input");
          const [waitingFor] = instance.waitingFor;
          assert(waitingFor);
          ctx.vars.instanceId = instance.id;
          ctx.vars.waitingFor = waitingFor;
        }),
        then.assert(
          "submitting the form connects GIFs with the key, which never enters the conversation",
          async (ctx) => {
            await ctx.runCodemode({
              scope: alice,
              code: `async () => await workflow.sendEvent(${JSON.stringify({
                instanceId: ctx.vars.instanceId,
                type: ctx.vars.waitingFor,
                payload: { key: "gifs-key" },
              })})`,
            });
            await ctx.runtime.drain();
            const run = await ctx.runCodemode({
              scope: alice,
              code: `async () => ({
                instance: await workflow.getInstance({ instanceId: ${JSON.stringify(ctx.vars.instanceId)} }),
                settings: (await integrations.get(${JSON.stringify(target)})).settings,
                search: await integrations.execute({ ...${JSON.stringify(target)}, actionId: "request", input: {
                  method: "GET", path: "/v1/gifs/search", query: { q: "cat" }, body: { type: "empty" },
                } }),
              })`,
            });
            expect(run.result).toMatchObject({
              instance: {
                details: {
                  status: "complete",
                  output: { connectionId: "api#gifs", status: "ready" },
                },
              },
              settings: { ...knownInput, location: "query", parameter: "api_key" },
              search: { ok: true },
            });
            expect(requests).toEqual([`${providerOrigin}/v1/gifs/search?q=cat&api_key=gifs-key`]);
            expect(await agentConversation(alice, ctx)).not.toContain("gifs-key");
          },
        ),
      ],
    }),
  );
});
