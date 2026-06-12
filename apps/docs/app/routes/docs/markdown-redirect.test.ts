import { describe, test, assert } from "vitest";

import { buildMarkdownApiUrl } from "./markdown-redirect";

describe("buildMarkdownApiUrl", () => {
  const baseUrl = "https://fragno.dev/docs/forms";

  test("builds correct URL for index page slugs", () => {
    // Index pages like /docs/forms should redirect to /api/markdown/forms
    // NOT /api/markdown/forms/index.mdx
    const url = buildMarkdownApiUrl(["forms"], baseUrl);
    assert(url.pathname === "/api/markdown/forms");
  });

  test("builds correct URL for nested page slugs", () => {
    const url = buildMarkdownApiUrl(["forms", "quickstart"], baseUrl);
    assert(url.pathname === "/api/markdown/forms/quickstart");
  });

  test("builds correct URL for deeply nested slugs", () => {
    const url = buildMarkdownApiUrl(["fragno", "for-library-authors", "routes"], baseUrl);
    assert(url.pathname === "/api/markdown/fragno/for-library-authors/routes");
  });

  test("handles empty slugs array", () => {
    const url = buildMarkdownApiUrl([], baseUrl);
    assert(url.pathname === "/api/markdown/");
  });

  test("preserves base URL origin", () => {
    const url = buildMarkdownApiUrl(["forms"], "https://example.com/docs/forms");
    assert(url.origin === "https://example.com");
  });
});
