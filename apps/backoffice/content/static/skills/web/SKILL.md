---
name: web
description:
  "Read web pages and download files from URLs with the web provider. Use when the user mentions a
  page or URL, wants its contents as HTML or Markdown, or wants the file behind a URL, such as an
  integration's download link, in the workspace."
---

# Web

The `web` provider reads a page with `web.extract` or saves the file behind a URL with
`web.download`. Read "/static/codemode/providers/web.d.ts" first, then follow the branch you need.

## Read a page

1. Select the source: a `url` supplied by the user or provided `html`. **Complete when** the exact
   source and supported input fields are known.

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
