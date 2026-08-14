import { FRAGNO_OUTBOX_PAGE_SIZE } from "@fragno-dev/db/outbox";

import type { FragnoOutboxEntry } from "../protocol";

export type FragnoInternalDescription = {
  adapterIdentity: string;
  currentVersionstamp: string | null;
  fragments: Array<{ name: string; mountRoute: string }>;
  schemas: Array<{
    name: string;
    namespace: string | null;
    version: number;
    tables: string[];
  }>;
  routes: {
    internal: "/_internal";
    outbox?: "/_internal/outbox";
    outboxStream?: "/_internal/outbox/stream";
  };
};

/** Typed Fetch access to the trusted Fragno internal routes used by outbox synchronization. */
export class FragnoInternalFetcher {
  readonly baseUrl: string;

  readonly #fetch: typeof globalThis.fetch;
  readonly #describeUrl: URL;
  readonly #outboxUrl: URL;
  readonly #outboxStreamUrl: URL;

  constructor(options: { baseUrl: string | URL; fetch: typeof globalThis.fetch }) {
    const baseUrl = new URL(options.baseUrl, globalThis.location?.href);
    baseUrl.hash = "";
    baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "");

    const internalUrl = new URL(baseUrl);
    internalUrl.pathname = `${baseUrl.pathname}/_internal`;
    const outboxUrl = new URL(internalUrl);
    outboxUrl.pathname = `${internalUrl.pathname}/outbox`;
    const outboxStreamUrl = new URL(internalUrl);
    outboxStreamUrl.pathname = `${internalUrl.pathname}/outbox/stream`;

    this.baseUrl = baseUrl.toString();
    this.#fetch = options.fetch;
    this.#describeUrl = internalUrl;
    this.#outboxUrl = outboxUrl;
    this.#outboxStreamUrl = outboxStreamUrl;
  }

  async describe(options: { signal?: AbortSignal } = {}): Promise<FragnoInternalDescription> {
    const response = await this.#get(this.#describeUrl, options.signal);
    const description = (await response.json()) as FragnoInternalDescription;
    return description;
  }

  async listOutbox(options: {
    afterVersionstamp?: string;
    signal?: AbortSignal;
  }): Promise<FragnoOutboxEntry[]> {
    const url = this.#outboxRequestUrl(this.#outboxUrl, options.afterVersionstamp);
    const response = await this.#get(url, options.signal);
    const entries = (await response.json()) as FragnoOutboxEntry[];
    return entries;
  }

  async openOutboxStream(options: {
    afterVersionstamp?: string;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    const url = this.#outboxRequestUrl(this.#outboxStreamUrl, options.afterVersionstamp);
    const response = await this.#get(url, options.signal);
    if (!response.body) {
      throw new Error("Fragno outbox stream response has no body.");
    }
    return response.body;
  }

  #outboxRequestUrl(route: URL, afterVersionstamp: string | undefined): URL {
    const url = new URL(route);
    if (afterVersionstamp) {
      url.searchParams.set("afterVersionstamp", afterVersionstamp);
    }
    url.searchParams.set("limit", String(FRAGNO_OUTBOX_PAGE_SIZE));
    return url;
  }

  async #get(url: URL, signal: AbortSignal | undefined): Promise<Response> {
    const response = await this.#fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`Fragno internal request failed: ${response.status} ${response.statusText}`);
    }
    return response;
  }
}
