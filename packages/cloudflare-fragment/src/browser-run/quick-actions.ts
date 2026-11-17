import type {
  AccessibilityTreeCreateParams,
  AccessibilityTreeCreateResponse,
} from "cloudflare/resources/browser-rendering/accessibility-tree";
import type {
  ContentCreateParams,
  ContentCreateResponse,
} from "cloudflare/resources/browser-rendering/content";
import type {
  CrawlCreateParams,
  CrawlCreateResponse,
  CrawlDeleteResponse,
  CrawlGetResponse,
} from "cloudflare/resources/browser-rendering/crawl";
import type {
  JsonCreateParams,
  JsonCreateResponse,
} from "cloudflare/resources/browser-rendering/json";
import type {
  LinkCreateParams,
  LinkCreateResponse,
} from "cloudflare/resources/browser-rendering/links";
import type {
  MarkdownCreateParams,
  MarkdownCreateResponse,
} from "cloudflare/resources/browser-rendering/markdown";
import type { PDFCreateParams } from "cloudflare/resources/browser-rendering/pdf";
import type {
  ScrapeCreateParams,
  ScrapeCreateResponse,
} from "cloudflare/resources/browser-rendering/scrape";
import type { ScreenshotCreateParams } from "cloudflare/resources/browser-rendering/screenshot";
import type {
  SnapshotCreateParams,
  SnapshotCreateResponse,
} from "cloudflare/resources/browser-rendering/snapshot";

import type { CloudflareApiClient } from "../cloudflare-api";

type WithoutAccountId<T> = T extends unknown ? Omit<T, "account_id"> : never;

export type BrowserRunContentInput = WithoutAccountId<ContentCreateParams>;
export type BrowserRunPdfInput = WithoutAccountId<PDFCreateParams>;
export type BrowserRunScrapeInput = WithoutAccountId<ScrapeCreateParams>;
export type BrowserRunScreenshotInput = WithoutAccountId<ScreenshotCreateParams>;
export type BrowserRunSnapshotInput = WithoutAccountId<SnapshotCreateParams>;
export type BrowserRunJsonInput = WithoutAccountId<JsonCreateParams>;
export type BrowserRunLinksInput = WithoutAccountId<LinkCreateParams>;
export type BrowserRunMarkdownInput = WithoutAccountId<MarkdownCreateParams>;
export type BrowserRunAccessibilityTreeInput = WithoutAccountId<AccessibilityTreeCreateParams>;
export type BrowserRunCrawlInput = WithoutAccountId<CrawlCreateParams>;

/** The header in which Cloudflare reports the browser time it bills a Quick Action for. */
export const BROWSER_MS_USED_HEADER = "x-browser-ms-used";

/** A Quick Action's result, with the browser time Cloudflare billed for it in milliseconds. */
export type BrowserRunMeteredResult<T> = { result: T; browserMsUsed: number };

/** Every Quick Action response reports its browser time, so one without it cannot be billed. */
export function readBrowserMsUsed(headers: Headers): number {
  const browserMsUsed = Number(headers.get(BROWSER_MS_USED_HEADER) ?? Number.NaN);
  if (!Number.isFinite(browserMsUsed) || browserMsUsed < 0) {
    throw new Error("Browser Run reported no browser time for the request.");
  }
  return browserMsUsed;
}

export type BrowserRunQuickActions = {
  content(input: BrowserRunContentInput): Promise<BrowserRunMeteredResult<ContentCreateResponse>>;
  /** The raw response, whose headers report its browser time. */
  pdf(input: BrowserRunPdfInput): Promise<Response>;
  scrape(input: BrowserRunScrapeInput): Promise<BrowserRunMeteredResult<ScrapeCreateResponse>>;
  /** The raw response, whose headers report its browser time. */
  screenshot(input: BrowserRunScreenshotInput): Promise<Response>;
  snapshot(
    input: BrowserRunSnapshotInput,
  ): Promise<BrowserRunMeteredResult<SnapshotCreateResponse>>;
  json(input: BrowserRunJsonInput): Promise<BrowserRunMeteredResult<JsonCreateResponse>>;
  links(input: BrowserRunLinksInput): Promise<BrowserRunMeteredResult<LinkCreateResponse>>;
  markdown(
    input: BrowserRunMarkdownInput,
  ): Promise<BrowserRunMeteredResult<MarkdownCreateResponse>>;
  accessibilityTree(
    input: BrowserRunAccessibilityTreeInput,
  ): Promise<BrowserRunMeteredResult<AccessibilityTreeCreateResponse>>;
  startCrawl(input: BrowserRunCrawlInput): Promise<CrawlCreateResponse>;
  getCrawl(jobId: string): Promise<CrawlGetResponse>;
  cancelCrawl(jobId: string): Promise<CrawlDeleteResponse>;
};

async function metered<T>(request: {
  withResponse(): Promise<{ data: T; response: Response }>;
}): Promise<BrowserRunMeteredResult<T>> {
  const { data, response } = await request.withResponse();
  return { result: data, browserMsUsed: readBrowserMsUsed(response.headers) };
}

async function meteredResponse(request: { asResponse(): Promise<Response> }): Promise<Response> {
  const response = await request.asResponse();
  readBrowserMsUsed(response.headers);
  return response;
}

export const createBrowserRunQuickActions = (
  cloudflare: CloudflareApiClient,
  accountId: string,
): BrowserRunQuickActions => ({
  content: (input) =>
    metered(cloudflare.browserRendering.content.create({ ...input, account_id: accountId })),
  pdf: (input) =>
    meteredResponse(cloudflare.browserRendering.pdf.create({ ...input, account_id: accountId })),
  scrape: (input) =>
    metered(cloudflare.browserRendering.scrape.create({ ...input, account_id: accountId })),
  screenshot: (input) =>
    meteredResponse(
      cloudflare.browserRendering.screenshot.create({ ...input, account_id: accountId }),
    ),
  snapshot: (input) =>
    metered(cloudflare.browserRendering.snapshot.create({ ...input, account_id: accountId })),
  json: (input) =>
    metered(cloudflare.browserRendering.json.create({ ...input, account_id: accountId })),
  links: (input) =>
    metered(cloudflare.browserRendering.links.create({ ...input, account_id: accountId })),
  markdown: (input) =>
    metered(cloudflare.browserRendering.markdown.create({ ...input, account_id: accountId })),
  accessibilityTree: (input) =>
    metered(
      cloudflare.browserRendering.accessibilityTree.create({ ...input, account_id: accountId }),
    ),
  startCrawl: (input) =>
    cloudflare.browserRendering.crawl.create({ ...input, account_id: accountId }),
  getCrawl: (jobId) => cloudflare.browserRendering.crawl.get(jobId, { account_id: accountId }),
  cancelCrawl: (jobId) =>
    cloudflare.browserRendering.crawl.delete(jobId, { account_id: accountId }),
});
