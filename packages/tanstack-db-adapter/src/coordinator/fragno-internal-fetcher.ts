import {
  fetchFragnoInternalDescription,
  FRAGNO_OUTBOX_PAGE_SIZE,
  resolveFragnoInternalUrls,
  type FragnoInternalDescription,
} from "@fragno-dev/db/outbox";

import type { FragnoOutboxCheckpoint } from "../checkpoint";
import { FragnoOutboxProtocolError } from "../outbox-stream";
import { rethrowOutboxNetworkFailure } from "../outbox-transport-error";

/** Typed Fetch access to the trusted Fragno internal routes used by outbox synchronization. */
export class FragnoInternalFetcher {
  readonly baseUrl: string;

  readonly #fetch: typeof globalThis.fetch;
  readonly #describeUrl: URL;
  readonly #outboxStreamUrl: URL;

  constructor(options: { baseUrl: string | URL; fetch: typeof globalThis.fetch }) {
    const urls = resolveFragnoInternalUrls(options.baseUrl);
    this.baseUrl = urls.baseUrl;
    this.#fetch = options.fetch;
    this.#describeUrl = urls.internal;
    this.#outboxStreamUrl = urls.outboxStream;
  }

  async describe(options: { signal?: AbortSignal } = {}): Promise<FragnoInternalDescription> {
    return await fetchFragnoInternalDescription({
      internalUrl: this.#describeUrl,
      fetch: this.#fetch,
      signal: options.signal,
    });
  }

  async openOutboxStream(options: {
    checkpoint: FragnoOutboxCheckpoint | undefined;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    const url = new URL(this.#outboxStreamUrl);
    url.searchParams.set("protocol", "1");
    if (options.checkpoint) {
      url.searchParams.set("afterVersionstamp", options.checkpoint.versionstamp);
      url.searchParams.set("afterUowId", options.checkpoint.uowId);
    }
    url.searchParams.set("limit", String(FRAGNO_OUTBOX_PAGE_SIZE));
    const request = new Request(url, { signal: options.signal });
    let response: Response;
    try {
      response = await this.#fetch(request);
    } catch (cause) {
      rethrowOutboxNetworkFailure(cause, options.signal);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 400 || response.status === 409) {
        throw new FragnoOutboxProtocolError(
          `Fragno outbox stream rejected its protocol or cursor: ${response.status}.`,
        );
      }
      throw new Error(
        `Fragno outbox stream request failed: ${response.status} ${response.statusText}`,
      );
    }
    if (!response.body) {
      throw new Error("Fragno outbox stream response has no body.");
    }
    return response.body;
  }
}
