// Web pages as content or Markdown, and files downloaded from URLs into the workspace. Read to fetch a web page or download a file.
type WebCodemodeProvider = {
  /**
   * Extract page content or Markdown from a URL or HTML.
   * Requires `cloudflare.browserRun`.
   */
  extract(input: WebExtractInput): Promise<WebExtractOutput>;
  /**
   * Download a file from a public https URL into the workspace. The request carries no credentials, follows up to 5 redirects, and stops after 30 seconds; hosts given as an IP address or localhost are refused, and so is a file above 1900000 bytes, the most a workspace file holds.
   * Requires `web.download` and `upload.modify`.
   */
  download(input: WebDownloadInput): Promise<WebDownloadOutput>;
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
type WebDownloadInput = {
  /** The https URL of the file, such as a temporary download link an integration returns. */
  url: string;
  /** Absolute path of the file to write under /workspace; an existing file is replaced. */
  path: string;
};
type WebDownloadOutput = {
  /** Where the file was written. */
  path: string;
  sizeBytes: number;
};
