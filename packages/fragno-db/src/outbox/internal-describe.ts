/** Response of `GET /_internal`, which identifies the backend an outbox replica mirrors. */
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

/** Internal route URLs below one normalized base URL. */
export type FragnoInternalUrls = {
  /** Without trailing slashes or hash, so replicas derive one stable identity per backend. */
  baseUrl: string;
  internal: URL;
  outbox: URL;
  outboxStream: URL;
};

export function resolveFragnoInternalUrls(baseUrl: string | URL): FragnoInternalUrls {
  const base = new URL(baseUrl, globalThis.location?.href);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("Fragno outbox synchronization requires an HTTP(S) base URL.");
  }
  base.hash = "";
  // URL normalizes an empty pathname back to "/", so derive child paths from the trimmed string.
  const basePath = base.pathname.replace(/\/+$/, "");
  base.pathname = basePath;

  const withPath = (path: string) => {
    const url = new URL(base);
    url.pathname = `${basePath}${path}`;
    return url;
  };
  const internal = withPath("/_internal");
  const outbox = withPath("/_internal/outbox");
  const outboxStream = withPath("/_internal/outbox/stream");

  return { baseUrl: base.toString(), internal, outbox, outboxStream };
}

export async function fetchFragnoInternalDescription(options: {
  internalUrl: URL;
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<FragnoInternalDescription> {
  const response = await options.fetch(options.internalUrl, { signal: options.signal });
  if (!response.ok) {
    throw new Error(`Fragno internal request failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as FragnoInternalDescription;
}
