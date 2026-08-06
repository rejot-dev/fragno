---
name: web
description:
  "Retrieve web pages when the user mentions a page or URL, asks to fetch or read its contents, or
  wants HTML or Markdown extracted from it."
---

# Web Pages

Retrieve the page with the `web` provider.

1. Read "/static/codemode/providers/web.d.ts" and select the source: a `url` supplied by the user or
   provided `html`. **Complete when** the exact source and supported input fields are known.

2. Choose the output shape:
   - `content` for rendered HTML;
   - `markdown` for readable page text.

   **Complete when** one action matches how the result will be used.

3. Call `web.extract`:

   ```js
   async () =>
     await web.extract({
       action: "markdown",
       input: { url: "https://example.com" },
     });
   ```

   Inspect the result branch selected by `action`. **Complete when** extraction succeeds and the
   returned content has been checked.
