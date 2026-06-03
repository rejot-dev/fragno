import { describe, expect, test } from "vitest";

import { env } from "cloudflare:workers";

import { createTestMasterFileSystem } from "@/fragno/automation/engine/test-master-file-system.test-utils";
import type { AutomationsRuntime } from "@/fragno/runtime-tools/families/automations";

import { createBashHost, createScriptRunnerRuntime, type BashHostContext } from "./bash-host";

describe("scripts.run codemode", () => {
  test("runs .cm.js scripts manually from an interactive bash host", async () => {
    const fs = createTestMasterFileSystem({
      "/workspace/automations/scripts/manual.cm.js": `async () => {
        const event = JSON.parse(await state.readFile("/context/event.json"));
        await state.writeFile("/workspace/output/manual-run.txt", event.id);
        console.log("manual codemode run");
        return { ok: true, eventId: event.id };
      }`,
      "/workspace/events/event.json": JSON.stringify({
        id: "manual-event-1",
        source: "telegram",
        eventType: "message.received",
        occurredAt: "2026-06-03T00:00:00.000Z",
        payload: { text: "hello" },
      }),
    });
    const context = createInteractiveContext({ fs });
    const { bash } = createBashHost({ fs, context });

    const result = await bash.exec(
      "scripts.run --script scripts/manual.cm.js --event /workspace/events/event.json --format json",
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout!.trim());
    expect(output).toMatchObject({
      runtime: "codemode",
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, eventId: "manual-event-1" }),
      stderr: "",
      logs: ["manual codemode run"],
      result: { ok: true, eventId: "manual-event-1" },
      commandCalls: [],
      toolCalls: [],
    });
    await expect(fs.readFile("/workspace/output/manual-run.txt")).resolves.toBe("manual-event-1");
  });
});

const createInteractiveContext = ({
  fs,
}: {
  fs: ReturnType<typeof createTestMasterFileSystem>;
}): BashHostContext => {
  const automationsRuntime: AutomationsRuntime = {
    lookupBinding: async () => null,
    bindActor: async (input) => ({
      source: input.source,
      key: input.key,
      value: input.value,
      description: input.description,
      status: "linked",
    }),
  };
  const context: BashHostContext = {
    automation: null,
    automations: { runtime: automationsRuntime },
    otp: null,
    pi: null,
    reson8: null,
    resend: null,
    telegram: null,
  };

  context.automations = {
    runtime: automationsRuntime,
    scriptRunner: createScriptRunnerRuntime({
      fileSystemConfig: { automationFileSystem: fs },
      env: env as CloudflareEnv,
      parentOrgId: "org-1",
      parentContext: context,
    }),
  };

  return context;
};
