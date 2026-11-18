export { createBrowserRunCaptureClient } from "./client";
export { BROWSER_MS_USED_HEADER, readBrowserMsUsed } from "./quick-actions";
export type { BrowserRunCaptureClient } from "./client";
export {
  browserRunCaptureInputSchema,
  browserRunCrawlActionInputSchema,
  browserRunCrawlActionResultSchema,
  browserRunExtractInputSchema,
  browserRunExtractResultSchema,
} from "./contracts";
export type {
  BrowserRunCaptureInput,
  BrowserRunCrawlActionInput,
  BrowserRunCrawlActionResult,
  BrowserRunExtractInput,
  BrowserRunExtractResult,
} from "./contracts";
// The schemas' types reference these, so consumers can name them in their declarations.
export type {
  CrawlCreateParams,
  CrawlDeleteResponse,
  CrawlGetResponse,
} from "cloudflare/resources/browser-rendering/crawl";
export type { PDFCreateParams } from "cloudflare/resources/browser-rendering/pdf";
export type { ScreenshotCreateParams } from "cloudflare/resources/browser-rendering/screenshot";
