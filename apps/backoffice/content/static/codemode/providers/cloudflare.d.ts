// Cloudflare Browser Run: screenshots, PDFs, crawls. Read to capture or crawl a page in a real browser.
type CloudflareCodemodeProvider = {
  /**
   * Capture a page as a PDF or screenshot with Cloudflare Browser Run.
   * Requires `cloudflare.browserRun`.
   */
  browserRunCapture(
    input: CloudflareBrowserRunCaptureInput,
  ): Promise<CloudflareBrowserRunCaptureOutput>;
  /**
   * Start, inspect, or cancel a Cloudflare Browser Run crawl job.
   * Requires `cloudflare.browserRun`.
   */
  browserRunCrawl(input: CloudflareBrowserRunCrawlInput): Promise<CloudflareBrowserRunCrawlOutput>;
};
declare const cloudflare: CloudflareCodemodeProvider;

type CloudflareBrowserRunCaptureInput = {
  action: "pdf" | "screenshot";
  input: {
    url?: string;
    html?: string;
    [key: string]: unknown;
  };
};
type CloudflareBrowserRunCaptureOutput = {
  contentType: string;
  data: string;
};
type CloudflareBrowserRunCrawlInput =
  | {
      action: "start";
      input: {
        url: string;
        [key: string]: unknown;
      };
    }
  | {
      action: "get" | "cancel";
      jobId: string;
    };
type CloudflareBrowserRunCrawlOutput =
  | {
      action: "start";
      result: {
        jobId: string;
      };
    }
  | {
      action: "get" | "cancel";
      result: unknown;
    };
