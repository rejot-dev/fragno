import { assert, describe, test } from "vitest";

import { renderToStaticMarkup } from "react-dom/server";

import { resolveFilesContentRenderer, type FilesContentPreview } from "./content-renderers";

describe("files content image rendering", () => {
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
