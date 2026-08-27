// cloudflare tools
type CloudflareCodemodeProvider = {
  /** Capture a page as a PDF or screenshot with Cloudflare Browser Run. */
  browserRunCapture(
    input: CloudflareBrowserRunCaptureInput,
  ): Promise<CloudflareBrowserRunCaptureOutput>;
  /** Start, inspect, or cancel a Cloudflare Browser Run crawl job. */
  browserRunCrawl(input: CloudflareBrowserRunCrawlInput): Promise<CloudflareBrowserRunCrawlOutput>;
};
declare const cloudflare: CloudflareCodemodeProvider;

type CloudflareBrowserRunCaptureInput =
  | {
      action: "pdf";
      input: {
        url?: string;
        html?: string;
        [key: string]: unknown;
      };
    }
  | {
      action: "screenshot";
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
      action: "get";
      jobId: string;
    }
  | {
      action: "cancel";
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
      action: "get";
      result: unknown;
    }
  | {
      action: "cancel";
      result: unknown;
    };
