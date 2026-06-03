import { describe, expect, test } from "vitest";

import { env } from "cloudflare:workers";

import type { AutomationBashHostContext, AutomationBashRuntime } from "@/fragno/automation";
import type { AutomationEvent } from "@/fragno/automation/contracts";

import { executeCodemodeAutomation } from "./codemode";
import { createTestMasterFileSystem } from "./test-master-file-system.test-utils";

describe("executeCodemodeAutomation", () => {
  test("runs a .cm.js automation with state.* and /context/event.json", async () => {
    const masterFs = createTestMasterFileSystem({});
    const event: AutomationEvent = {
      id: "event-codemode-1",
      orgId: "org-1",
      source: "test",
      eventType: "message.received",
      occurredAt: "2026-06-03T00:00:00.000Z",
      payload: { text: "hello" },
    };

    const result = await executeCodemodeAutomation({
      env,
      masterFs,
      context: createAutomationContext(event),
      script: `async () => {
        const event = JSON.parse(await state.readFile("/context/event.json"));
        await state.writeFile("/workspace/output.json", JSON.stringify({
          id: event.id,
          text: event.payload.text,
        }));
        console.log("codemode automation wrote output");
        return { ok: true, eventId: event.id };
      }`,
    });

    expect(result).toMatchObject({
      runtime: "codemode",
      eventId: "event-codemode-1",
      scriptId: "script:codemode@1:scripts/context-writer.cm.js",
      exitCode: 0,
      stderr: "",
      logs: ["codemode automation wrote output"],
      result: { ok: true, eventId: "event-codemode-1" },
      stdout: JSON.stringify({ ok: true, eventId: "event-codemode-1" }),
      toolCalls: [],
    });
    await expect(masterFs.readFile("/workspace/output.json")).resolves.toBe(
      JSON.stringify({ id: "event-codemode-1", text: "hello" }),
    );
  });
});

const createAutomationContext = (event: AutomationEvent): AutomationBashHostContext => {
  const runtime = createUnusedAutomationRuntime();

  return {
    automation: {
      event,
      orgId: event.orgId,
      binding: {
        id: "codemode-binding",
        source: event.source,
        eventType: event.eventType,
        scriptId: "script:codemode@1:scripts/context-writer.cm.js",
        scriptKey: "codemode",
        scriptName: "Codemode",
        scriptPath: "scripts/context-writer.cm.js",
        scriptVersion: 1,
        scriptEnv: {},
      },
      idempotencyKey: "idem-codemode",
      bashEnv: {},
      runtime,
    },
    automations: { runtime },
    otp: { runtime },
    pi: null,
    reson8: { runtime: createUnavailableRuntime("reson8") },
    resend: { runtime: createUnavailableRuntime("resend") },
    telegram: { runtime: createUnavailableRuntime("telegram") },
  };
};

const createUnusedAutomationRuntime = (): AutomationBashRuntime => ({
  lookupBinding: async () => {
    throw new Error("lookupBinding should not be called in this test.");
  },
  bindActor: async () => {
    throw new Error("bindActor should not be called in this test.");
  },
  createClaim: async () => {
    throw new Error("createClaim should not be called in this test.");
  },
  emitEvent: async () => {
    throw new Error("emitEvent should not be called in this test.");
  },
});

const createUnavailableRuntime = (name: string) =>
  new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error(`${name} runtime should not be called in this test.`);
        };
      },
    },
  ) as never;
