import type {
  BrowserRunCaptureInput,
  BrowserRunCrawlActionInput,
  BrowserRunCrawlActionResult,
} from "@fragno-dev/cloudflare-fragment/browser-run";
import { createRouteCaller } from "@fragno-dev/core/api";

import type {
  BackofficeObjectHandle,
  CloudflareObject,
} from "@/backoffice-runtime/object-registry";
import type { CloudflareFragment } from "@/fragno/cloudflare";

import {
  isSuccessStatus,
  throwOnHttpResponseError,
  throwOnRouteRuntimeError,
} from "../runtime-errors";

export type CloudflareRuntime = {
  browserRunCapture(input: BrowserRunCaptureInput): Promise<Response>;
  browserRunCrawl(input: BrowserRunCrawlActionInput): Promise<BrowserRunCrawlActionResult>;
};

const BROWSER_RUN_CAPTURE_TIMEOUT_MS = 60_000;

type CloudflareHttpTransport = Pick<BackofficeObjectHandle<CloudflareObject>["http"], "fetch">;

export const createCloudflareRuntime = ({
  http,
}: {
  http: CloudflareHttpTransport;
}): CloudflareRuntime => {
  const callRoute = createRouteCaller<CloudflareFragment>({
    baseUrl: "https://cloudflare.do",
    mountRoute: "/api/cloudflare",
    fetch: http.fetch.bind(http),
  });

  return {
    browserRunCapture: async (input) => {
      const response = await http.fetch(
        new Request("https://cloudflare.do/api/cloudflare/browser-run/capture", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(BROWSER_RUN_CAPTURE_TIMEOUT_MS),
        }),
      );

      if (!response.ok) {
        return await throwOnHttpResponseError(response, {
          runtimeLabel: "Cloudflare fragment",
          label: "cloudflare.browserRunCapture",
          notConfiguredMessage:
            "Cloudflare is not configured. Set the Cloudflare account ID and API token.",
        });
      }

      return response;
    },
    browserRunCrawl: async (input) => {
      const response = await callRoute("POST", "/browser-run/crawl", { body: input });

      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data as BrowserRunCrawlActionResult;
      }

      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Cloudflare fragment",
        label: "cloudflare.browserRunCrawl",
        notConfiguredMessage:
          "Cloudflare is not configured. Set the Cloudflare account ID and API token.",
      });
    },
  };
};
