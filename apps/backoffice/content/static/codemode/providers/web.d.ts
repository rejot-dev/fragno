// URL and HTML extraction to content or Markdown. Read to fetch a web page.
type WebCodemodeProvider = {
  /**
   * Extract page content or Markdown from a URL or HTML.
   * Requires `cloudflare.browserRun`.
   */
  extract(input: WebExtractInput): Promise<WebExtractOutput>;
};
declare const web: WebCodemodeProvider;

type WebExtractInput = {
  action: "content" | "markdown";
  input: {
    url?: string;
    html?: string;
    [key: string]: unknown;
  };
};
type WebExtractOutput = {
  action: "content" | "markdown";
  result: string;
};
