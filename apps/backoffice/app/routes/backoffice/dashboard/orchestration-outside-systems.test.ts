import { describe, expect, test } from "vitest";

import { runtimeToolWorkflowCatalog } from "@/fragno/runtime-tools/workflow-catalog.server";

import { workflowOutsideCalls } from "./orchestration-outside-systems";

const filename = "/workspace/automations/sync.workflow.js";

/** The outside systems a workflow calls when its one step runs `body`. */
function systemsCalledBy(body: string): string[] {
  const code = `export default defineWorkflow({ name: "sync" }, async (event, step) => {
  await step.do("sync", async () => {
    ${body}
  });
});`;
  return workflowOutsideCalls([{ filename, code }], runtimeToolWorkflowCatalog).map(
    ({ workflowId, externalId }) => `${workflowId} → ${externalId}`,
  );
}

describe("the outside systems a workflow calls", () => {
  test("leave out Backoffice's own tools, and setting up integrations", () => {
    expect(
      systemsCalledBy(`
        await state.readFile({ path: "/workspace/notes.md" });
        await router.list();
        await integrations.list();`),
    ).toEqual([]);
  });

  test("include integration actions and Browser Run, once per workflow and system", () => {
    expect(
      systemsCalledBy(`
        await integrations.execute({ connectionId: "slack#team", actionId: "post" });
        await integrations.execute({ connectionId: "github#acme", actionId: "issue" });
        await cloudflare.browserRunCapture({ url: "https://example.com" });`),
    ).toEqual([`workflow:${filename} → browser-run`, `workflow:${filename} → integrations`]);
  });
});
