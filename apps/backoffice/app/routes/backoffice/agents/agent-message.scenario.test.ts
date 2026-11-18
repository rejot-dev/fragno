import { expect, test } from "vitest";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import {
  behindBackofficeLayout,
  sessionUserId,
  withBackofficeAccessToken,
} from "@/layouts/backoffice-layout.test-support";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { createScriptedPiAgentDependencies } from "../../../../workers/pi-durable-scenario.test-support";
import { PiObject } from "../../../../workers/pi-object";
import { sendPiAgentMessage } from "./agent-message.server";

function personalScope(userId: string) {
  return { kind: "user", userId, jurisdiction: null } as const;
}

/** Sends a message from an agent's composer, as the person whose session `cookie` carries. */
async function sendMessage(ctx: BackofficeScenarioContext, agentName: string, content: string) {
  const request = new Request(`https://backoffice.example/backoffice/agents/${agentName}`, {
    method: "POST",
    headers: { cookie: ctx.vars.cookie as string },
  });
  const context = createBackofficeRouterContextProvider(request, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
  const formData = new FormData();
  formData.set("content", content);
  return await behindBackofficeLayout(() =>
    sendPiAgentMessage({
      request,
      context,
      scope: personalScope(ctx.vars.userId as string),
      agentName,
      requestId: crypto.randomUUID(),
      formData,
    }),
  )({ request, context, params: {} });
}

test("people write to assistants, and agents with a category take work only from agents and workflows", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "agent categories",
      objects: {
        ...allLocalObjects,
        PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) => {
          const faux = fauxProvider();
          faux.setResponses([
            fauxAssistantMessage("Here is your week."),
            fauxAssistantMessage("Reconciled."),
          ]);
          const models = createModels();
          models.setProvider(faux.provider);
          return new PiObject({
            state,
            runtime,
            dependencies: createScriptedPiAgentDependencies(models),
            openStorage: openPiSessionStore,
            idFromConfig: piAgentIdFromConfig,
            nowEpochMs,
          });
        },
      },
      piAvailableModels: [
        {
          provider: "faux",
          modelId: "faux-1",
          label: "Faux 1",
          contextWindow: 128_000,
          thinkingLevels: ["off"],
        },
      ],
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "grace@example.test", captureSessionCookieAs: "session" }),
        then.assert("Grace works in her personal scope", async (ctx) => {
          ctx.vars.userId = await sessionUserId(ctx, ctx.vars.session as string);
          ctx.vars.cookie = await withBackofficeAccessToken(ctx, ctx.vars.session as string, null);
        }),
        then.assert("the assistant defines a bookkeeper listed under Finance", async (ctx) => {
          const { result } = await ctx.runCodemode({
            scope: personalScope(ctx.vars.userId as string),
            code: `async () => await pi.createAgent({
              agentName: "bookkeeper",
              description: "Reconciles the books every night.",
              model: null,
              permissions: ["*"],
              instructions: "",
              category: "Finance",
            })`,
          });
          expect(result).toMatchObject({ agentName: "bookkeeper", category: "Finance" });
        }),
        then.assert("Grace's message to the bookkeeper is refused", async (ctx) => {
          await expect(sendMessage(ctx, "bookkeeper", "Reconcile March.")).resolves.toEqual({
            ok: false,
            error: "Bookkeeper takes work from agents and workflows, not messages.",
          });
        }),
        then.assert("her message to her assistant is queued", async (ctx) => {
          await expect(sendMessage(ctx, "assistant", "Plan my week.")).resolves.toMatchObject({
            ok: true,
            receipt: { status: "queued" },
          });
        }),
        then.assert("a workflow's prompt to the bookkeeper is queued", async (ctx) => {
          const { result } = await ctx.runCodemode({
            scope: personalScope(ctx.vars.userId as string),
            code: `async () => await pi.submitPrompt({ agentName: "bookkeeper", content: "Reconcile March." })`,
          });
          expect(result).toMatchObject({ status: "queued" });
        }),
      ],
    }),
  );
});
