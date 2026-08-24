import { assert, describe, test } from "vitest";

import { renderToStaticMarkup } from "react-dom/server";

import { ORGANIZATION_STARTER_AUTOMATION_ROUTES } from "@/fragno/automation/content/starter-routing";

import { resolveFilesContentRenderer, type FilesContentPreview } from "./content-renderers";

describe("files content rendering", () => {
  test("renders workflow JavaScript files as workflow graphs", () => {
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
    const markup = renderToStaticMarkup(renderer.render(preview));

    assert.equal(renderer.id, "workflow");
    assert(markup.includes('aria-label="Workflow graph"'));
    assert(markup.includes("daily-digest"));
    assert(markup.includes("Send digest"));
  });

  test("renders the configured project-created start route", () => {
    const workflowPath = "/static/automations/project-files-configure.workflow.js";
    const route = ORGANIZATION_STARTER_AUTOMATION_ROUTES.find(
      (candidate) =>
        candidate.action.kind === "start_workflow" &&
        candidate.action.workflowScriptPath === workflowPath,
    );
    assert(route);
    const preview: FilesContentPreview = {
      title: "project-files-configure.workflow.js",
      contentType: "text/javascript",
      metadata: null,
      textContent:
        'defineWorkflow({ name: "project-files-configure" }, async (_event, step) => {});',
      workflowRouting: {
        status: "ready",
        routes: [{ ...route, nextOccurrenceAt: null }],
      },
    };

    const renderer = resolveFilesContentRenderer(preview);
    assert(renderer);
    const markup = renderToStaticMarkup(renderer.render(preview));

    assert(markup.includes("Runs on"));
    assert(markup.includes("automations / project.created"));
    assert(markup.includes("Configure project files"));
  });

  test("renders multiple schedule routes with enabled state and next occurrence", () => {
    const workflowAction = {
      kind: "start_workflow" as const,
      authority: { kind: "organization-automation" as const },
      workflowScriptPath: "/workspace/automations/daily-digest.workflow.js",
      instanceIdTemplate: "daily-${event.id}",
    };
    const preview: FilesContentPreview = {
      title: "daily-digest.workflow.js",
      contentType: "text/javascript",
      metadata: null,
      textContent: 'defineWorkflow({ name: "daily-digest" }, async () => {});',
      workflowRouting: {
        status: "ready",
        routes: [
          {
            id: "weekday-digest",
            name: "Weekday digest",
            enabled: false,
            priority: 10,
            trigger: {
              kind: "schedule",
              cadence: { kind: "cron", expression: "0 9 * * 1-5", timeZone: "America/New_York" },
            },
            action: workflowAction,
            nextOccurrenceAt: "2026-08-24T13:00:00.000Z",
          },
          {
            id: "launch-digest",
            name: "Launch digest",
            enabled: true,
            priority: 20,
            trigger: {
              kind: "schedule",
              cadence: { kind: "once", at: "2026-08-25T12:00:00.000Z" },
            },
            action: workflowAction,
            nextOccurrenceAt: "2026-08-25T12:00:00.000Z",
          },
        ],
      },
    };

    const renderer = resolveFilesContentRenderer(preview);
    assert(renderer);
    const markup = renderToStaticMarkup(renderer.render(preview));

    assert(markup.includes("Scheduled · Disabled"));
    assert(markup.includes("Cron · 0 9 * * 1-5 · America/New_York"));
    assert(markup.includes("Weekday digest"));
    assert(markup.includes("Launch digest"));
    assert(markup.includes("Aug 24, 2026, 09:00 America/New_York"));
  });

  test("renders Markdown files with the shared Streamdown renderer", () => {
    const preview: FilesContentPreview = {
      title: "README.md",
      contentType: "text/markdown",
      metadata: null,
      textContent: "# Explorer heading\n\n- One\n- Two",
      workflowRouting: { status: "unavailable" },
    };

    const renderer = resolveFilesContentRenderer(preview);
    assert(renderer);
    const markup = renderToStaticMarkup(renderer.render(preview));

    assert.equal(renderer.id, "markdown");
    assert(markup.includes("Explorer heading"));
    assert(markup.includes("bo-session-markdown"));
    assert(markup.includes("bo-file-markdown"));
    assert(markup.includes("<h1"));
  });

  test("renders Markdown frontmatter above the document body", () => {
    const preview: FilesContentPreview = {
      title: "SKILL.md",
      contentType: "text/markdown",
      metadata: null,
      textContent: "---\nname: explorer\ndescription: Browse files\n---\n\n# Instructions",
      workflowRouting: { status: "unavailable" },
    };

    const renderer = resolveFilesContentRenderer(preview);
    assert(renderer);
    const preambleMarkup = renderToStaticMarkup(renderer.renderBefore?.(preview));
    const bodyMarkup = renderToStaticMarkup(renderer.render(preview));

    assert(preambleMarkup.includes("Frontmatter"));
    assert(preambleMarkup.includes("<dt"));
    assert(preambleMarkup.includes(">name</dt>"));
    assert(preambleMarkup.includes(">explorer</dd>"));
    assert(bodyMarkup.includes("Instructions"));
    assert(!bodyMarkup.includes("name: explorer"));
  });

  test("ignores media type parameters when selecting a renderer", () => {
    const preview: FilesContentPreview = {
      title: "README.md",
      contentType: "Text/Markdown; charset=utf-8",
      metadata: null,
      textContent: "# Parameterized Markdown",
      workflowRouting: { status: "unavailable" },
    };

    const renderer = resolveFilesContentRenderer(preview);

    assert(renderer);
    assert.equal(renderer.id, "markdown");
  });

  test("uses the first allowed metadata image source", () => {
    const preview = createImagePreview({
      previewUrl: "https://images.example.com/unsafe.png",
      src: "/previews/safe.png",
    });

    const renderer = resolveFilesContentRenderer(preview);
    assert(renderer);
    const markup = renderToStaticMarkup(renderer.render(preview));

    assert(markup.includes('src="/previews/safe.png"'));
  });

  test("allows supported image data URLs", () => {
    const preview = createImagePreview({ dataUrl: "data:image/png;base64,AAAA" });

    const renderer = resolveFilesContentRenderer(preview);
    assert(renderer);
    const markup = renderToStaticMarkup(renderer.render(preview));

    assert(markup.includes("data:image/png;base64,AAAA"));
  });

  test("falls back to SVG text when metadata sources are unsafe", () => {
    const preview: FilesContentPreview = {
      ...createImagePreview({ previewUrl: "javascript:alert(1)" }),
      contentType: "image/svg+xml",
      textContent: "<svg></svg>",
    };

    const renderer = resolveFilesContentRenderer(preview);
    assert(renderer);
    const markup = renderToStaticMarkup(renderer.render(preview));

    assert(markup.includes("data:image/svg+xml;charset=utf-8"));
    assert(!markup.includes("javascript:"));
  });
});

function createImagePreview(metadata: Record<string, unknown>): FilesContentPreview {
  return {
    title: "Preview",
    contentType: "image/png",
    metadata,
    textContent: null,
    workflowRouting: { status: "unavailable" },
  };
}
