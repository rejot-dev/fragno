import type {
  BrowserRunExtractInput,
  BrowserRunExtractResult,
} from "@fragno-dev/cloudflare-fragment/browser-run";
import { createRouteCaller } from "@fragno-dev/core/api";

import type { CloudflareObject } from "@/backoffice-runtime/object-registry";
import type { CloudflareFragment } from "@/fragno/cloudflare";

import { isSuccessStatus, throwOnRouteRuntimeError } from "../runtime-errors";

export type WebExtractInput = Extract<BrowserRunExtractInput, { action: "content" | "markdown" }>;
export type WebExtractResult = Extract<BrowserRunExtractResult, { action: "content" | "markdown" }>;

export type WebRuntime = {
  extract(input: WebExtractInput): Promise<WebExtractResult>;
};

export const createWebRuntime = ({ object }: { object: CloudflareObject }): WebRuntime => {
  const callRoute = createRouteCaller<CloudflareFragment>({
    baseUrl: "https://cloudflare.do",
    mountRoute: "/api/cloudflare",
    fetch: object.fetch.bind(object),
  });

  return {
    extract: async (input) => {
      const response = await callRoute("POST", "/browser-run/extract", {
        body: input,
      });

      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data as WebExtractResult;
      }

      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Web runtime",
        label: "web.extract",
        notConfiguredMessage: "Web extraction is not configured.",
      });
    },
  };
};
