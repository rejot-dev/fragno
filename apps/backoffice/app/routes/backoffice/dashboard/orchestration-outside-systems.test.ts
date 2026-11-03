import { describe, expect, test } from "vitest";

import { runtimeToolWorkflowCatalog } from "@/fragno/runtime-tools/workflow-catalog.server";

import { workflowOutsideCalls, type WorkflowConnections } from "./orchestration-outside-systems";

const filename = "/workspace/automations/sync.workflow.js";

// The connections of the scope the workflow runs in.
const connections: WorkflowConnections = [
  { connectionId: "connector#slack-team", service: "slack", displayName: "Slack · team" },
  { connectionId: "github#acme/site", service: "github", displayName: "acme/site" },
];

/** The outside systems a workflow calls when its one step runs `body`, with their names and icons. */
function systemsCalledBy(body: string): string[] {
  const code = `export default defineWorkflow({ name: "sync" }, async (event, step) => {
  await step.do("sync", async () => {
    ${body}
  });
});`;
  return workflowOutsideCalls([{ filename, code }], runtimeToolWorkflowCatalog, connections).map(
    ({ workflowId, external }) => {
      expect(workflowId).toBe(`workflow:${filename}`);
      return `${external.id} "${external.label}" ${external.icon}`;
    },
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

  test("include Browser Run, and each connection an integration action names, once each", () => {
    expect(
      systemsCalledBy(`
        await integrations.execute({ connectionId: "connector#slack-team", actionId: "post" });
        await integrations.execute({ "connectionId": "github#acme/site", actionId: "issue" });
        await integrations.execute({ actionId: "post", connectionId: "connector#slack-team" });
        await cloudflare.browserRunCapture({ url: "https://example.com" });`),
    ).toEqual([
      'browser-run "Browser Run" monitor',
      'connection:connector#slack-team "Slack · team" link',
      'connection:github#acme/site "acme/site" git-branch',
    ]);
  });

  test("name a connection the scope has no record of by its address", () => {
    expect(
      systemsCalledBy(`await integrations.execute({ connectionId: "mcp#linear", actionId: "x" });`),
    ).toEqual(['connection:mcp#linear "linear" disc']);
  });

  test("share one system for actions whose connection is only known as the workflow runs", () => {
    expect(
      systemsCalledBy(`
        await integrations.execute({ connectionId: event.payload.connection, actionId: "a" });
        await integrations.execute({ connectionId: "connector#" + event.payload.team, actionId: "b" });
        await integrations.execute({ actionId: "c", input: { connectionId: "github#acme/site" } });
        const request = { connectionId: "github#acme/site", actionId: "d" };
        await integrations.execute(request);`),
    ).toEqual(['integrations "Integrations" link']);
  });
});
