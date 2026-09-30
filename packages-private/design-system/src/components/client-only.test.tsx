import { describe, expect, test, vi } from "vitest";

import { renderToStaticMarkup } from "react-dom/server";

import { ClientOnly } from "./client-only";

describe("ClientOnly", () => {
  test("does not evaluate render children during server rendering", () => {
    const renderClientContent = vi.fn(() => <span>Client content</span>);

    const markup = renderToStaticMarkup(
      <ClientOnly fallback={<span>Server fallback</span>}>{renderClientContent}</ClientOnly>,
    );

    expect(markup).toContain("Server fallback");
    expect(renderClientContent).not.toHaveBeenCalled();
  });
});
