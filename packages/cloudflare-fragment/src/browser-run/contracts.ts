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
import { z } from "zod";

type WithoutAccountId<T> = T extends unknown ? Omit<T, "account_id"> : never;

const browserRunPageInputSchema = z
  .looseObject({
    url: z.url().optional(),
    html: z.string().optional(),
  })
  .refine((input) => input.url !== undefined || input.html !== undefined, {
    message: "Browser Run input requires either `url` or `html`.",
  });

const typedPageInputSchema = <TInput>() => browserRunPageInputSchema as z.ZodType<TInput, TInput>;

const pageActionSchema = <TAction extends string, TInput>(
  action: TAction,
  inputSchema: z.ZodType<TInput, TInput>,
) =>
  z.object({
    action: z.literal(action),
    input: inputSchema,
  });

export const browserRunExtractInputSchema = z.discriminatedUnion("action", [
  pageActionSchema("content", typedPageInputSchema<WithoutAccountId<ContentCreateParams>>()),
  pageActionSchema("scrape", typedPageInputSchema<WithoutAccountId<ScrapeCreateParams>>()),
  pageActionSchema("snapshot", typedPageInputSchema<WithoutAccountId<SnapshotCreateParams>>()),
  pageActionSchema("json", typedPageInputSchema<WithoutAccountId<JsonCreateParams>>()),
  pageActionSchema("links", typedPageInputSchema<WithoutAccountId<LinkCreateParams>>()),
  pageActionSchema("markdown", typedPageInputSchema<WithoutAccountId<MarkdownCreateParams>>()),
  pageActionSchema(
    "accessibility-tree",
    typedPageInputSchema<WithoutAccountId<AccessibilityTreeCreateParams>>(),
  ),
]);

export const browserRunCaptureInputSchema = z.discriminatedUnion("action", [
  pageActionSchema("pdf", typedPageInputSchema<WithoutAccountId<PDFCreateParams>>()),
  pageActionSchema("screenshot", typedPageInputSchema<WithoutAccountId<ScreenshotCreateParams>>()),
]);

const browserRunCrawlInputSchema = z.looseObject({
  url: z.url(),
}) as z.ZodType<WithoutAccountId<CrawlCreateParams>, WithoutAccountId<CrawlCreateParams>>;

export const browserRunCrawlActionInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    input: browserRunCrawlInputSchema,
  }),
  z.object({
    action: z.literal("get"),
    jobId: z.string().trim().min(1),
  }),
  z.object({
    action: z.literal("cancel"),
    jobId: z.string().trim().min(1),
  }),
]);

const actionResultSchema = <TAction extends string, TResultSchema extends z.ZodType>(
  action: TAction,
  resultSchema: TResultSchema,
) =>
  z.object({
    action: z.literal(action),
    result: resultSchema,
  });

export const browserRunExtractResultSchema = z.discriminatedUnion("action", [
  actionResultSchema("content", z.string() satisfies z.ZodType<ContentCreateResponse>),
  actionResultSchema("scrape", z.custom<ScrapeCreateResponse>()),
  actionResultSchema("snapshot", z.custom<SnapshotCreateResponse>()),
  actionResultSchema(
    "json",
    z.record(z.string(), z.unknown()) satisfies z.ZodType<JsonCreateResponse>,
  ),
  actionResultSchema("links", z.array(z.string()) satisfies z.ZodType<LinkCreateResponse>),
  actionResultSchema("markdown", z.string() satisfies z.ZodType<MarkdownCreateResponse>),
  actionResultSchema("accessibility-tree", z.custom<AccessibilityTreeCreateResponse>()),
]);

export const browserRunCrawlActionResultSchema = z.discriminatedUnion("action", [
  actionResultSchema(
    "start",
    z.object({
      jobId: z.string(),
    }),
  ),
  actionResultSchema("get", z.custom<CrawlGetResponse>()),
  actionResultSchema("cancel", z.custom<CrawlDeleteResponse>()),
]);

export type BrowserRunExtractInput = z.infer<typeof browserRunExtractInputSchema>;
export type BrowserRunCaptureInput = z.infer<typeof browserRunCaptureInputSchema>;
export type BrowserRunCrawlActionInput = z.infer<typeof browserRunCrawlActionInputSchema>;
export type BrowserRunExtractResult = z.infer<typeof browserRunExtractResultSchema>;
export type BrowserRunCrawlActionResult = z.infer<typeof browserRunCrawlActionResultSchema>;
