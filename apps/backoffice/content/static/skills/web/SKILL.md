---
name: web
description:
  "Search the web, read web pages, and download files from URLs with the web provider. Use when you
  need a page you have no URL for, such as a provider's API documentation; when the user mentions a
  page or URL or wants its contents as HTML or Markdown; or when the user wants the file behind a
  URL, such as an integration's download link, in the workspace."
---

# Web

The `web` provider finds pages with `web.search`, reads a page with `web.extract`, and saves the
file behind a URL with `web.download`. Read "/static/codemode/providers/web.d.ts" first, then follow
the branch you need.

## Search the web

1. Write the query in the words the page itself would use: the product and the topic, such as
   `Acme API authentication`. **Complete when** the query names one product and one topic.

2. Call `web.search`:

   ```js
   async () => await web.search({ query: "Acme API authentication" });
   ```

   Each search is billed to the scope's owner, so reuse results within a task instead of repeating a
   query. **Complete when** a result is the page you need, preferring the provider's own
   documentation domain over copies elsewhere, or a rephrased search found none either.

3. Read the chosen result as in "Read a page". A description summarizes the page, so take facts such
   as base URLs, auth methods, and endpoints from the page itself. **Complete when** every fact you
   use comes from a page you read.

## Read a page

1. Select the source: a `url` supplied by the user or found by a search, or provided `html`.
   **Complete when** the exact source and supported input fields are known.

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

## Download a file

1. Choose the path under `/workspace`. Its extension sets the file's type, so take the name from the
   integration's metadata or the URL, such as `/workspace/downloads/logo.png`. **Complete when** the
   path ends in the extension of the file's real type.

2. Call `web.download`:

   ```js
   async () =>
     await web.download({
       url: link,
       path: "/workspace/downloads/logo.png",
     });
   ```

   **Complete when** it returns the `path` and `sizeBytes` of the saved file.

3. Recover from a failure by its code:
   - `WEB_DOWNLOAD_FAILED` carries the server's answer. A temporary link that answers 403 or 404 has
     usually expired: get a fresh one from its source and download again.
   - `WEB_DOWNLOAD_URL_REFUSED`: ask for a public https link.
   - `WEB_DOWNLOAD_TOO_LARGE`: the file exceeds what a workspace file holds. Tell the user, with the
     link to open it directly.

   **Complete when** the file is saved or the user knows why it cannot be.
