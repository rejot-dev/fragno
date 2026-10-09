import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";
import { env } from "cloudflare:workers";

import { createRegistry, type ConversationView } from "@earendil-works/pi-durable";

import {
  BACKOFFICE_SYSTEM_ACTORS,
  createBackofficeSystemExecution,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { createCloudflareDurableObjectRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createRuntimeStateBackend } from "@/fragno/codemode/runtime-state-backend";
import { piAgentObjectName } from "@/fragno/pi-manager/pi-agent-contract";
import {
  javaScriptBuildToolFamily,
  javaScriptRunToolFamily,
} from "@/fragno/runtime-tools/families/javascript";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { executeBackofficeRuntimeTool } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";

import { openPiSessionStore } from "./lib/pi-session-store";
import { InMemoryPiObject } from "./pi.do";

/** Builds through native streamed RPC, then opens and restarts with only a Worker Loader. */
test("precompiled workspace extensions open concurrently and after restart without a compiler", async () => {
  const testEnv = env as CloudflareEnv & { PI_EXTENSION_COMPILER: Fetcher };
  const scope = { kind: "org", orgId: `extension-gate-${crypto.randomUUID()}` } as const;
  const config: PiAgentConfig = {
    scope,
    sessionId: crypto.randomUUID(),
    name: "Streamed extension agent",
    model: { provider: "faux", modelId: "faux-1" },
    instructions: "Use the extension guidance.",
    actors: BACKOFFICE_SYSTEM_ACTORS,
    billingOrganizationId: null,
    scopeRestriction: null,
  };
  const stub = testEnv.PI.getByName(piAgentObjectName(config));
  await runInDurableObject(stub, async (_instance, state) => {
    const runtime = {
      ...createCloudflareDurableObjectRuntimeServices(testEnv, state),
      codemodeEnv: {
        LOADER: testEnv.LOADER,
        CODEMODE_COMPILER: testEnv.PI_EXTENSION_COMPILER,
      },
    };
    const files = createRuntimeStateBackend({
      runtime,
      kernel: new BackofficeKernel(runtime),
      execution: createBackofficeSystemExecution(scope),
    });
    await files.writeFile(
      "/workspace/pi/extensions.json",
      JSON.stringify({
        extensions: ["./.build/gate.extension.json"],
      }),
    );
    await files.writeFile(
      "/workspace/pi/extensions/gate.extension.js",
      `console.log("Native module startup");
      export default {
      name: "gate-context",
      sections: [{ key: "gate_context", render: () => "Streamed workspace guidance" }],
      tools: [{
        name: "gate_tool", description: "Exercise native RPC capabilities", parameters: { type: "object", properties: {} },
        execute: async (_args, api, context) => {
          const winner = await api.memo("gate", "native memo", context);
          if (winner !== await api.memo("gate", context)) throw new Error("Native memo mismatch");
          api.output(new TextEncoder().encode("Streamed tool output"));
          api.diagnostic({ severity: "info", message: "Native RPC report" });
          await api.details({ memo: winner, callId: api.callId }, context);
          return {};
        },
      }],
      hooks: [{ task: "pi.tool", handlers: {
        afterTool: (_call, result) => ({ ...result, content: [{ type: "text", text: "Native hook: " + result.content[0].text }] }),
      } }],
    };`,
    );

    const buildContext = createCodemodeRouteBackedRuntimeContext({
      runtime,
      kernel: new BackofficeKernel(runtime),
      execution: createBackofficeSystemExecution(scope),
      billingOrganizationId: null,
    });
    const build = await executeBackofficeRuntimeTool(
      javaScriptBuildToolFamily.tools[0],
      {
        path: "/workspace/pi/extensions/gate.extension.js",
        out: "/workspace/pi/.build/gate.extension.json",
      },
      createBackofficeToolContext(buildContext),
    );
    expect(build).toMatchObject({ status: "success" });
    const executionRuntime = { ...runtime, codemodeEnv: { LOADER: testEnv.LOADER } };
    const runContext = createCodemodeRouteBackedRuntimeContext({
      runtime: executionRuntime,
      kernel: new BackofficeKernel(executionRuntime),
      execution: createBackofficeSystemExecution(scope),
      billingOrganizationId: null,
    });
    const ran = await executeBackofficeRuntimeTool(
      javaScriptRunToolFamily.tools[0],
      { path: "/workspace/pi/.build/gate.extension.json" },
      createBackofficeToolContext(runContext),
    );
    expect(ran).toEqual({
      status: "success",
      path: "/workspace/pi/.build/gate.extension.json",
      logs: ["Native module startup"],
    });

    const sourceWithoutCompiler = await executeBackofficeRuntimeTool(
      javaScriptRunToolFamily.tools[0],
      { path: "/workspace/pi/extensions/gate.extension.js" },
      createBackofficeToolContext(runContext),
    );
    expect(sourceWithoutCompiler).toMatchObject({ status: "error" });

    for (const requestId of ["first-open", "reopened"]) {
      const faux = fauxProvider();
      faux.setResponses([
        (context) => {
          expect(JSON.stringify(context.messages)).toContain("Streamed workspace guidance");
          return {
            ...fauxAssistantMessage(""),
            stopReason: "toolUse",
            content: [
              { type: "toolCall", id: `native-${requestId}`, name: "gate_tool", arguments: {} },
            ],
          };
        },
        (context) => {
          expect(JSON.stringify(context.messages)).toContain("Native hook: Streamed tool output");
          return fauxAssistantMessage(`Extension completed ${requestId}.`);
        },
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      const reports: unknown[] = [];
      const object = new InMemoryPiObject({
        state,
        runtime: executionRuntime,
        options: { models, registry: createRegistry(), onReport: (error) => reports.push(error) },
        openStorage: () => openPiSessionStore(state.storage),
        idFromConfig: (input) => testEnv.PI.idFromName(piAgentObjectName(input)),
        nowEpochMs: Date.now,
      });
      try {
        // Both requests share one harness; artifact loading and rendering cannot consult a compiler.
        const views = await Promise.all([object.getView(config), object.getView(config)]);
        expect(views[0]).toEqual(views[1]);
        await object.submit(config, {
          requestId,
          content: "Read the extension.",
          whenBusy: "followUp",
        });
        await object.alarm();
        const view = (await object.getView(config)) as ConversationView;
        expect(JSON.stringify(view.entries)).toContain(`Extension completed ${requestId}.`);
        expect(reports).toEqual([]);
      } finally {
        await object.close();
      }
    }
  });
});
