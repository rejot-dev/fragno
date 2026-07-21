import type { FragnoOutboxEntry } from "./protocol";

export type FragnoOutboxIdentityRequest = {
  signal: AbortSignal;
};

export type FragnoOutboxRequest = {
  afterVersionstamp?: string;
  limit: number;
  signal: AbortSignal;
};

/** Reads the durable Fragno outbox without owning cursor or polling state. */
export type FragnoOutboxTransport = {
  getAdapterIdentity(options: FragnoOutboxIdentityRequest): Promise<string>;
  list(options: FragnoOutboxRequest): Promise<FragnoOutboxEntry[]>;
};

export function createFetchFragnoOutboxTransport(options: {
  internalUrl: string | URL;
  fetch?: typeof globalThis.fetch;
}): FragnoOutboxTransport {
  const fetch = options.fetch ?? globalThis.fetch;
  const internalUrl = new URL(options.internalUrl, getUrlBase()).toString();
  const outboxUrl = createFragnoOutboxUrl(internalUrl);

  return {
    async getAdapterIdentity(request) {
      const response = await fetch(internalUrl, { signal: request.signal });
      if (!response.ok) {
        throw new Error(
          `Fragno internal describe request failed: ${response.status} ${response.statusText}`,
        );
      }

      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body["adapterIdentity"] !== "string") {
        throw new Error("Invalid Fragno internal describe response.");
      }
      return body["adapterIdentity"];
    },
    async list(request) {
      const response = await fetch(createFragnoOutboxRequestUrl(outboxUrl, request), {
        signal: request.signal,
      });

      if (!response.ok) {
        throw new Error(`Fragno outbox request failed: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as FragnoOutboxEntry[];
    },
  };
}

export function createFragnoOutboxUrl(internalUrl: string | URL): string {
  const url = new URL(internalUrl, getUrlBase());
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/outbox`;
  return url.toString();
}

export function createFragnoOutboxRequestUrl(
  route: string | URL,
  request: Pick<FragnoOutboxRequest, "afterVersionstamp" | "limit">,
): string {
  const url = new URL(route, getUrlBase());

  if (request.afterVersionstamp) {
    url.searchParams.set("afterVersionstamp", request.afterVersionstamp);
  } else {
    url.searchParams.delete("afterVersionstamp");
  }
  url.searchParams.set("limit", String(request.limit));

  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getUrlBase(): string | undefined {
  return typeof globalThis.location?.href === "string" ? globalThis.location.href : undefined;
}
