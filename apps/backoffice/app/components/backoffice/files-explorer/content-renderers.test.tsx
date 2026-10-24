import { assert, describe, test } from "vitest";

import { renderToStaticMarkup } from "react-dom/server";

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
      inlineHref: null,
      workflowRouting: { status: "unavailable" },
      pageHref: null,
    };

    const renderer = resolveFilesContentRenderer(preview);
    assert(renderer);
    const markup = renderToStaticMarkup(renderer.render(preview));

    assert.equal(renderer.id, "workflow");
    assert(markup.includes('aria-label="Workflow graph"'));
    assert(markup.includes("daily-digest"));
    assert(markup.includes("Send digest"));
  });

  test("renders multiple schedule routes with enabled state and next occurrence", () => {
    const workflowAction = {
      kind: "start_workflow" as const,
      authority: { kind: "organization-automation" as const, grants: [] },
      workflowScriptPath: "/workspace/automations/daily-digest.workflow.js",
      instanceIdTemplate: "daily-${event.id}",
    };
    const preview: FilesContentPreview = {
      title: "daily-digest.workflow.js",
      contentType: "text/javascript",
      metadata: null,
      textContent: 'defineWorkflow({ name: "daily-digest" }, async () => {});',
      inlineHref: null,
      pageHref: null,
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
      inlineHref: null,
      workflowRouting: { status: "unavailable" },
      pageHref: null,
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
      inlineHref: null,
      workflowRouting: { status: "unavailable" },
      pageHref: null,
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
      inlineHref: null,
      workflowRouting: { status: "unavailable" },
      pageHref: null,
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

  test("embeds any image/* type through the host file route", () => {
    const preview: FilesContentPreview = {
      ...createImagePreview({}),
      contentType: "image/avif",
      inlineHref: "/files/download?path=%2Fworkspace%2Fphoto.avif&disposition=inline",
    };

    const renderer = resolveFilesContentRenderer(preview);
    assert(renderer);
    const markup = renderToStaticMarkup(renderer.render(preview));

    assert.equal(renderer.id, "image");
    assert(
      markup.includes(
        'src="/files/download?path=%2Fworkspace%2Fphoto.avif&amp;disposition=inline"',
      ),
    );
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
    inlineHref: null,
    workflowRouting: { status: "unavailable" },
    pageHref: null,
  };
}
