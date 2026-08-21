// @vitest-environment happy-dom

import { afterEach, assert, describe, test } from "vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { resolveFilesContentRenderer, type FilesContentPreview } from "./content-renderers";

afterEach(cleanup);

describe("workflow file preview", () => {
  test("switches between graph and code tabs", () => {
    const preview: FilesContentPreview = {
      title: "daily-digest.workflow.js",
      contentType: "text/javascript",
      metadata: null,
      textContent: `defineWorkflow({ name: "daily-digest" }, async (_event, step) => {
  await step.do("Send digest", async () => undefined);
});`,
      workflowRouting: { status: "unavailable" },
    };
    const renderer = resolveFilesContentRenderer(preview);
    assert(renderer);

    render(renderer.render(preview));

    assert.equal(screen.getByRole("tab", { name: "Graph" }).getAttribute("aria-selected"), "true");
    assert(screen.getByLabelText("Workflow graph"));
    assert.equal(screen.queryByLabelText("Workflow code"), null);

    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    assert.equal(screen.getByRole("tab", { name: "Code" }).getAttribute("aria-selected"), "true");
    assert(screen.getByLabelText("Workflow code").textContent?.includes("defineWorkflow"));
    assert.equal(screen.queryByLabelText("Workflow graph"), null);
  });

  test("shows authoritative start route triggers above the source graph", () => {
    const preview: FilesContentPreview = {
      title: "telegram-user-linking.workflow.js",
      contentType: "text/javascript",
      metadata: null,
      textContent: `defineWorkflow({ name: "telegram-user-linking" }, async (event) => {
  if (event.payload.text !== "/start") return { skipped: true };
});`,
      workflowRouting: {
        status: "ready",
        routes: [
          {
            id: "telegram-start-linking",
            name: "Telegram /start identity linking",
            enabled: true,
            priority: 100,
            trigger: {
              kind: "event",
              source: "telegram",
              eventType: "message.received",
              matcher: { path: "$.payload.text", op: "eq", value: "/start" },
            },
            action: {
              kind: "start_workflow",
              authority: { kind: "organization-automation" },
              workflowScriptPath: "/workspace/automations/telegram-user-linking.workflow.js",
              instanceIdTemplate: "telegram-link-${event.id}",
            },
            nextOccurrenceAt: null,
          },
        ],
      },
    };
    const renderer = resolveFilesContentRenderer(preview);
    assert(renderer);

    render(renderer.render(preview));

    assert(screen.getByLabelText("Workflow start routes"));
    assert(screen.getByText("Runs on"));
    assert(screen.getByText("telegram / message.received"));
    assert(screen.getByText('$.payload.text equals "/start"'));
    assert(screen.getByLabelText("Workflow graph").textContent?.includes("event.payload.text"));
  });
});
