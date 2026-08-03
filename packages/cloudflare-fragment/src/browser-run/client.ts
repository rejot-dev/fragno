import type { BrowserRunCaptureInput } from "./contracts";

export type BrowserRunCaptureClient = (
  input: BrowserRunCaptureInput,
  options?: RequestInit,
) => Promise<Response>;

export const createBrowserRunCaptureClient = ({
  buildUrl,
  fetcher,
  defaultOptions,
}: {
  buildUrl: (path: string) => string;
  fetcher: typeof fetch;
  defaultOptions?: RequestInit;
}): BrowserRunCaptureClient => {
  return async (input, options = {}) => {
    const headers = new Headers(defaultOptions?.headers);
    new Headers(options.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    headers.set("content-type", "application/json");

    return fetcher(buildUrl("/browser-run/capture"), {
      ...defaultOptions,
      ...options,
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
  };
};
