import { STATE_FILE_MAX_BYTES } from "@fragno-dev/backoffice-api/v0/state";
import type {
  BrowserRunExtractInput,
  BrowserRunExtractResult,
} from "@fragno-dev/cloudflare-fragment/browser-run";
import { createRouteCaller } from "@fragno-dev/core/api";

import type { FetchCommands } from "@/backoffice-runtime/object-registry";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import type { CloudflareFragment } from "@/fragno/cloudflare";
import { readBoundedBytes } from "@/lib/bounded-bytes";

import { isSuccessStatus, NotConfiguredError, throwOnRouteRuntimeError } from "../runtime-errors";

export type WebExtractInput = Extract<BrowserRunExtractInput, { action: "content" | "markdown" }>;
export type WebExtractResult = Extract<BrowserRunExtractResult, { action: "content" | "markdown" }>;

export type WebRuntime = {
  extract(input: WebExtractInput): Promise<WebExtractResult>;
  download(url: string): Promise<Uint8Array>;
};

const WEB_DOWNLOAD_MAX_REDIRECTS = 5;
const WEB_DOWNLOAD_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function downloadError(code: "URL_REFUSED" | "FAILED" | "TOO_LARGE", message: string) {
  return new BackofficeOperationError(
    code === "FAILED" ? "operation_failed" : "invalid_request",
    `WEB_DOWNLOAD_${code}: ${message}`,
  );
}

/**
 * Deployed Workers reach only public addresses, but `wrangler dev` reaches the developer's machine
 * and network, so hosts that name one directly are refused at every hop. There, a hostname that
 * resolves to a private address still passes, if it serves a certificate valid for that name.
 */
function publicHttpsUrl(url: string): URL {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/\.$/u, "");
  const refused =
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    // URL parsing turns every IPv4 spelling into dotted decimal and brackets IPv6.
    /^\d+\.\d+\.\d+\.\d+$/u.test(host) ||
    host.startsWith("[");
  if (refused) {
    throw downloadError(
      "URL_REFUSED",
      `${url} is not a public https URL: downloads refuse credentials, IP addresses, and localhost.`,
    );
  }
  return parsed;
}

async function readCapped(response: Response, url: string): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array();
  }
  const contentLength = response.headers.get("content-length");
  const declared = contentLength === null ? null : Number(contentLength);
  const bytes = await readBoundedBytes(
    // A response body streams bytes; the Workers types leave its chunks untyped.
    response.body as ReadableStream<Uint8Array>,
    declared !== null && Number.isSafeInteger(declared) ? declared : null,
    STATE_FILE_MAX_BYTES,
  );
  if (bytes === null) {
    throw downloadError(
      "TOO_LARGE",
      `${url} is larger than ${STATE_FILE_MAX_BYTES} bytes, the most a workspace file holds.`,
    );
  }
  return bytes;
}

async function follow(
  fetch: typeof globalThis.fetch,
  url: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  let target = publicHttpsUrl(url);
  for (let redirects = 0; ; redirects += 1) {
    // Redirects are followed here, so each target passes the same check as the first.
    const response = await fetch(target, { redirect: "manual", signal });
    if (!REDIRECT_STATUSES.has(response.status)) {
      if (!response.ok) {
        await response.body?.cancel();
        throw downloadError("FAILED", `${url} answered ${response.status}.`);
      }
      return await readCapped(response, url);
    }
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (location === null || redirects === WEB_DOWNLOAD_MAX_REDIRECTS) {
      throw downloadError(
        "FAILED",
        location === null
          ? `${url} redirected without a location.`
          : `${url} redirected more than ${WEB_DOWNLOAD_MAX_REDIRECTS} times.`,
      );
    }
    target = publicHttpsUrl(new URL(location, target).href);
  }
}

async function download(fetch: typeof globalThis.fetch, url: string): Promise<Uint8Array> {
  try {
    return await follow(fetch, url, AbortSignal.timeout(WEB_DOWNLOAD_TIMEOUT_MS));
  } catch (error) {
    if (error instanceof BackofficeOperationError) {
      throw error;
    }
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? `did not finish within ${WEB_DOWNLOAD_TIMEOUT_MS / 1000} seconds`
        : `could not be downloaded: ${error instanceof Error ? error.message : String(error)}`;
    throw downloadError("FAILED", `${url} ${reason}.`);
  }
}

export const createWebRuntime = ({
  cloudflare,
  fetch,
}: {
  /** Browser Run extracts pages; null when the deployment has no Cloudflare binding. */
  cloudflare: FetchCommands | null;
  /** Reaches the public internet for downloads; null where the runtime cannot download. */
  fetch: typeof globalThis.fetch | null;
}): WebRuntime => {
  const callRoute = cloudflare
    ? createRouteCaller<CloudflareFragment>({
        baseUrl: "https://cloudflare.do",
        mountRoute: "/api/cloudflare",
        fetch: cloudflare.fetch.bind(cloudflare),
      })
    : null;

  return {
    extract: async (input) => {
      if (!callRoute) {
        throw new NotConfiguredError("Web extraction is not configured.");
      }
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
    download: async (url) => {
      if (!fetch) {
        throw new NotConfiguredError(
          "Downloading from URLs is not available in the Node runtime, which cannot keep " +
            "connections to public addresses.",
        );
      }
      return await download(fetch, url);
    },
  };
};
