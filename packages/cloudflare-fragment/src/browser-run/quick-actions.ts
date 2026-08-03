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

export type BrowserRunQuickActions = {
  content(input: BrowserRunContentInput): Promise<ContentCreateResponse>;
  pdf(input: BrowserRunPdfInput): Promise<Response>;
  scrape(input: BrowserRunScrapeInput): Promise<ScrapeCreateResponse>;
  screenshot(input: BrowserRunScreenshotInput): Promise<Response>;
  snapshot(input: BrowserRunSnapshotInput): Promise<SnapshotCreateResponse>;
  json(input: BrowserRunJsonInput): Promise<JsonCreateResponse>;
  links(input: BrowserRunLinksInput): Promise<LinkCreateResponse>;
  markdown(input: BrowserRunMarkdownInput): Promise<MarkdownCreateResponse>;
  accessibilityTree(
    input: BrowserRunAccessibilityTreeInput,
  ): Promise<AccessibilityTreeCreateResponse>;
  startCrawl(input: BrowserRunCrawlInput): Promise<CrawlCreateResponse>;
  getCrawl(jobId: string): Promise<CrawlGetResponse>;
  cancelCrawl(jobId: string): Promise<CrawlDeleteResponse>;
};

export const createBrowserRunQuickActions = (
  cloudflare: CloudflareApiClient,
  accountId: string,
): BrowserRunQuickActions => ({
  content: (input) =>
    cloudflare.browserRendering.content.create({ ...input, account_id: accountId }),
  pdf: (input) => cloudflare.browserRendering.pdf.create({ ...input, account_id: accountId }),
  scrape: (input) => cloudflare.browserRendering.scrape.create({ ...input, account_id: accountId }),
  screenshot: (input) =>
    cloudflare.browserRendering.screenshot.create({ ...input, account_id: accountId }).asResponse(),
  snapshot: (input) =>
    cloudflare.browserRendering.snapshot.create({ ...input, account_id: accountId }),
  json: (input) => cloudflare.browserRendering.json.create({ ...input, account_id: accountId }),
  links: (input) => cloudflare.browserRendering.links.create({ ...input, account_id: accountId }),
  markdown: (input) =>
    cloudflare.browserRendering.markdown.create({ ...input, account_id: accountId }),
  accessibilityTree: (input) =>
    cloudflare.browserRendering.accessibilityTree.create({ ...input, account_id: accountId }),
  startCrawl: (input) =>
    cloudflare.browserRendering.crawl.create({ ...input, account_id: accountId }),
  getCrawl: (jobId) => cloudflare.browserRendering.crawl.get(jobId, { account_id: accountId }),
  cancelCrawl: (jobId) =>
    cloudflare.browserRendering.crawl.delete(jobId, { account_id: accountId }),
});
