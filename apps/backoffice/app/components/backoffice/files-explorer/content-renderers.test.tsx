import { assert, describe, test } from "vitest";

import { renderToStaticMarkup } from "react-dom/server";

import { resolveFilesContentRenderer, type FilesContentPreview } from "./content-renderers";

describe("files content rendering", () => {
  test("renders Markdown files with the shared Streamdown renderer", () => {
    const preview: FilesContentPreview = {
      title: "README.md",
      contentType: "text/markdown",
      metadata: null,
      textContent: "# Explorer heading\n\n- One\n- Two",
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
  };
}
