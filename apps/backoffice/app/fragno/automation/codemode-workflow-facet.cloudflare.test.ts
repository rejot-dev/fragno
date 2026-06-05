/// <reference types="@cloudflare/vitest-pool-workers/types" />

import {
  abortAllDurableObjects,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, test } from "vitest";

import fragnoWorkflowRuntimeBundle from "@fragno-dev/workflows/dynamic-runtime?raw";
import { env } from "cloudflare:workers";

import { createWorker } from "@cloudflare/worker-bundler";

import {
  createCodemodeAutomationWorkflowInstance,
  codemodeAutomationWorkflowInstanceIdFor,
  codemodeAutomationWorkflowLoaderId,
  type CodemodeAutomationWorkflowBinding,
} from "./codemode-workflow-facet";
import type { AutomationEvent } from "./contracts";
import { CodemodeWorkflowToolDispatcher, getAutomationCodemodeTools } from "./engine/codemode";

describe("codemode automation workflow facet", () => {
  afterEach(async () => {
    await reset();
  });
  test("worker-bundler can load the workspace Fragno workflow runtime bundle", async () => {
    const bundled = await createWorker({
      entryPoint: "src/index.ts",
      files: {
        "src/index.ts": `
          import {
            CloudflareDurableObjectsDriverConfig,
            createFragmentDurableObjectHost,
            createWorkflowsFragment,
            defaultFragnoRuntime,
            defineWorkflow,
            DurableObjectDialect,
            SqlAdapter,
          } from "./fragno-workflow-runtime.js";

          const workflow = defineWorkflow({ name: "hello-workflow" }, () => ({ ok: true }));

          export default {
            fetch() {
              return Response.json({
                workflowName: workflow.name,
                runtimeExports: [
                  CloudflareDurableObjectsDriverConfig,
                  createFragmentDurableObjectHost,
                  createWorkflowsFragment,
                  defaultFragnoRuntime,
                  DurableObjectDialect,
                  SqlAdapter,
                ].map((runtimeExport) => typeof runtimeExport),
              });
            }
          };
        `,
        "src/fragno-workflow-runtime.js": fragnoWorkflowRuntimeBundle,
        "wrangler.jsonc": JSON.stringify({
          compatibility_date: "2026-05-07",
          compatibility_flags: ["nodejs_compat"],
        }),
      },
      conditions: ["workerd", "worker", "import", "default"],
      externals: ["cloudflare:workers"],
    });

    const worker = env.LOADER.get("codemode-workflow-fragno-import-smoke", () => ({
      mainModule: bundled.mainModule,
      modules: bundled.modules,
      compatibilityDate: "2026-05-07",
      compatibilityFlags: ["nodejs_compat"],
    }));

    const response = await worker.getEntrypoint().fetch("https://example.test/");

    await expect(response.json()).resolves.toEqual({
      workflowName: "hello-workflow",
      runtimeExports: ["function", "function", "function", "object", "function", "function"],
    });
  });

  test("resumes a sleeping Telegram workflow after Durable Objects are aborted", async () => {
    const binding: CodemodeAutomationWorkflowBinding = {
      id: "sleeping-telegram-binding",
      scriptId: "sleeping-telegram-codemode-workflow",
      scriptVersion: 1,
      scriptBody: `defineWorkflow({ name: "sleeping-telegram-codemode-workflow" }, async ({ payload }, step) => {
        await step.sleep("initial pause", 1);
        return await telegram.sendMessage({
          chatId: payload.event.payload.chatId,
          text: "Resumed workflow message",
        });
      })`,
    };
    const event: AutomationEvent = {
      id: "event-sleeping-telegram",
      orgId: "org-codemode-workflows",
      source: "telegram",
      eventType: "telegram.message.received",
      occurredAt: "2026-06-04T00:00:00.000Z",
      payload: { chatId: "chat-resume" },
    };
    const telegramDo = env.TELEGRAM.get(env.TELEGRAM.idFromName(event.orgId!));
    await telegramDo.setAdminConfig(
      {
        orgId: event.orgId,
        botToken: "123456:telegram-bot-token",
        webhookSecretToken: "telegram-webhook-secret",
        botUsername: "fragno_bot",
      },
      "https://example.com",
    );

    const tools = getAutomationCodemodeTools({
      automations: null,
      otp: null,
      pi: null,
      reson8: null,
      resend: null,
      automation: {
        event,
        orgId: event.orgId,
        idempotencyKey: event.id,
        binding: {
          id: binding.id,
          scriptId: binding.scriptId,
          scriptVersion: binding.scriptVersion,
          source: event.source,
          eventType: event.eventType,
        },
        bashEnv: {},
        runtime: undefined as never,
      },
      telegram: {
        runtime: {
          getFile: async () => ({ fileId: "file" }),
          downloadFile: async () => new Response(),
          sendMessage: async () => ({ ok: true, queued: true }),
          sendChatAction: async () => ({ ok: true }),
          editMessage: async () => ({ ok: true, queued: true }),
        },
      },
    });
    const host = env.AUTOMATIONS.get(
      env.AUTOMATIONS.idFromName("codemode-workflow-sleeping-telegram-host"),
    );
    const inputBase = {
      orgId: event.orgId ?? "",
      binding,
      event,
      env,
      tools,
    };
    const instanceId = codemodeAutomationWorkflowInstanceIdFor({
      ...inputBase,
      state: undefined as never,
      toolDispatcher: undefined,
    });
    const workflowName = "sleeping-telegram-codemode-workflow";

    await runInDurableObject(host, async (_instance, state) => {
      const response = await createCodemodeAutomationWorkflowInstance({
        ...inputBase,
        state,
        toolDispatcher: new CodemodeWorkflowToolDispatcher({ env: env as CloudflareEnv }),
        syncFacetAlarm: async ({ facetName, facet }) => {
          const alarmStateResponse = await facet.fetch(
            "https://automation-workflow.local/__automation-workflow/alarm-state",
          );
          const alarmState = (await alarmStateResponse.json()) as { alarmTime?: number | null };
          if (alarmState.alarmTime == null) {
            return;
          }

          await state.storage.put(`__facet_alarm__:${facetName}`, alarmState.alarmTime);
          await state.storage.setAlarm(alarmState.alarmTime);
        },
      });

      expect(response.status).toBe(200);
    });

    await abortAllDurableObjects();

    const resumedHost = env.AUTOMATIONS.get(
      env.AUTOMATIONS.idFromName("codemode-workflow-sleeping-telegram-host"),
    );
    for (let i = 0; i < 5; i++) {
      await runDurableObjectAlarm(resumedHost);
    }

    const result = await runInDurableObject(resumedHost, async (_instance, state) => {
      const loaderId = codemodeAutomationWorkflowLoaderId(binding);
      const worker = env.LOADER.get(loaderId, async () => {
        throw new Error(`Expected cached codemode workflow worker for ${loaderId}.`);
      });
      const facet = state.facets.get(loaderId, () => ({
        class: worker.getDurableObjectClass("AutomationWorkflowFacet"),
        id: loaderId,
      }));
      const detailResponse = await facet.fetch(
        new Request(
          `https://automation-workflow.local/api/workflows/${workflowName}/instances/${instanceId}`,
        ),
      );

      return {
        detailStatus: detailResponse.status,
        detail: await detailResponse.json(),
      };
    });

    expect(result.detailStatus).toBe(200);
    expect(result.detail).toMatchObject({
      id: instanceId,
      details: {
        status: "complete",
        output: { ok: true, queued: true },
      },
    });
  });

  test("createCodemodeAutomationWorkflowInstance creates and runs a stepped workflow", async () => {
    const binding: CodemodeAutomationWorkflowBinding = {
      id: "simple-binding",
      scriptId: "simple-codemode-workflow",
      scriptVersion: 1,
      scriptBody: `defineWorkflow({ name: "simple-codemode-workflow" }, async ({ payload }, step) => {
        const value = payload.event.payload.value;
        const first = await step.do("first step", () => ({ value: value + 1 }));
        const second = await step.do("second step", () => ({ value: first.value * 2 }));
        const third = await step.do("third step", () => ({ value: second.value + 3 }));

        return third;
      })`,
    };
    const event: AutomationEvent = {
      id: "event-dynamic-steps",
      orgId: "org-codemode-workflows",
      source: "test",
      eventType: "dynamic.workflow.test",
      occurredAt: "2026-06-04T00:00:00.000Z",
      payload: { value: 4 },
    };
    const host = env.AUTOMATIONS.get(env.AUTOMATIONS.idFromName("codemode-workflow-test-host"));
    const inputBase = {
      orgId: event.orgId ?? "",
      binding,
      event,
      env,
      tools: [],
    };
    const instanceId = codemodeAutomationWorkflowInstanceIdFor({
      ...inputBase,
      state: undefined as never,
      toolDispatcher: undefined,
    });
    const workflowName = "simple-codemode-workflow";

    const createResult = await runInDurableObject(host, async (_instance, state) => {
      const response = await createCodemodeAutomationWorkflowInstance({
        ...inputBase,
        state,
        syncFacetAlarm: async ({ facetName, facet }) => {
          const alarmStateResponse = await facet.fetch(
            "https://automation-workflow.local/__automation-workflow/alarm-state",
          );
          const alarmState = (await alarmStateResponse.json()) as { alarmTime?: number | null };
          if (alarmState.alarmTime == null) {
            return;
          }

          await state.storage.put(`__facet_alarm__:${facetName}`, alarmState.alarmTime);
          await state.storage.setAlarm(alarmState.alarmTime);
        },
      });

      return {
        status: response.status,
        body: await response.json(),
      };
    });

    expect(createResult).toMatchObject({
      status: 200,
      body: {
        id: instanceId,
        details: { status: expect.stringMatching(/^(active|complete)$/) },
      },
    });

    for (let i = 0; i < 5; i++) {
      await runDurableObjectAlarm(host);
    }

    const result = await runInDurableObject(host, async (_instance, state) => {
      const loaderId = codemodeAutomationWorkflowLoaderId(binding);
      const worker = env.LOADER.get(loaderId, async () => {
        throw new Error(`Expected cached codemode workflow worker for ${loaderId}.`);
      });
      const facet = state.facets.get(loaderId, () => ({
        class: worker.getDurableObjectClass("AutomationWorkflowFacet"),
        id: loaderId,
      }));
      const detailResponse = await facet.fetch(
        new Request(
          `https://automation-workflow.local/api/workflows/${workflowName}/instances/${instanceId}`,
        ),
      );
      const historyResponse = await facet.fetch(
        new Request(
          `https://automation-workflow.local/api/workflows/${workflowName}/instances/${instanceId}/history`,
        ),
      );

      return {
        detailStatus: detailResponse.status,
        detail: await detailResponse.json(),
        historyStatus: historyResponse.status,
        history: await historyResponse.json(),
      };
    });

    expect(result.detailStatus).toBe(200);
    expect(result.detail).toMatchObject({
      id: instanceId,
      details: {
        status: "complete",
        output: { value: 13 },
      },
    });
    expect(result.historyStatus).toBe(200);
    expect(result.history).toMatchObject({
      steps: [
        expect.objectContaining({ name: "first step", status: "completed", result: { value: 5 } }),
        expect.objectContaining({
          name: "second step",
          status: "completed",
          result: { value: 10 },
        }),
        expect.objectContaining({ name: "third step", status: "completed", result: { value: 13 } }),
      ],
    });
  });
});
