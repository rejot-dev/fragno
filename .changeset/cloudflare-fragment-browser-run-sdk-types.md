---
"@fragno-dev/cloudflare-fragment": patch
---

feat: export the Cloudflare SDK types the Browser Run schemas reference

`@fragno-dev/cloudflare-fragment/browser-run` exports `CrawlCreateParams`, `CrawlDeleteResponse`,
`CrawlGetResponse`, `PDFCreateParams`, and `ScreenshotCreateParams`, so packages that export values
typed by its schemas can name these types in their declarations without depending on `cloudflare`.
