// web tools
type WebCodemodeProvider = {
  /** Extract page content or Markdown from a URL or HTML. */
  extract(input: WebExtractInput): Promise<WebExtractOutput>;
};
declare const web: WebCodemodeProvider;

type WebExtractInput =
  | {
      action: "content";
      input: {
        url?: string;
        html?: string;
        [key: string]: unknown;
      };
    }
  | {
      action: "markdown";
      input: {
        url?: string;
        html?: string;
        [key: string]: unknown;
      };
    };
type WebExtractOutput =
  | {
      action: "content";
      result: string;
    }
  | {
      action: "markdown";
      result: string;
    };
