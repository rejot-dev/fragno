import { describe, expect, test } from "vitest";
import { buildMarkdownApiUrl } from "./markdown-redirect";

describe("buildMarkdownApiUrl", () => {
  const baseUrl = "https://fragno.dev/docs/forms";

  test("builds correct URL for index page slugs", () => {
    // Index pages like /docs/forms should redirect to /api/markdown/forms
    // NOT /api/markdown/forms/index.mdx
    const url = buildMarkdownApiUrl(["forms"], baseUrl);
    expect(url.pathname).toBe("/api/markdown/forms");
  });

  test("builds correct URL for nested page slugs", () => {
    const url = buildMarkdownApiUrl(["forms", "quickstart"], baseUrl);
    expect(url.pathname).toBe("/api/markdown/forms/quickstart");
  });

  test("builds correct URL for deeply nested slugs", () => {
    const url = buildMarkdownApiUrl(["fragno", "for-library-authors", "routes"], baseUrl);
    expect(url.pathname).toBe("/api/markdown/fragno/for-library-authors/routes");
  });

  test("handles empty slugs array", () => {
    const url = buildMarkdownApiUrl([], baseUrl);
    expect(url.pathname).toBe("/api/markdown/");
  });

  test("preserves base URL origin", () => {
    const url = buildMarkdownApiUrl(["forms"], "https://example.com/docs/forms");
    expect(url.origin).toBe("https://example.com");
  });
});
