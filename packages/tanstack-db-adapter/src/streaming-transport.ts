import type { FragnoOutboxEntry } from "./protocol";
import {
  createFetchFragnoOutboxTransport,
  createFragnoOutboxRequestUrl,
  type FragnoOutboxRequest,
  type FragnoOutboxTransport,
} from "./transport";

export type FragnoOutboxStreamRequest = FragnoOutboxRequest & {
  onEntry(entry: FragnoOutboxEntry): void | Promise<void>;
};

export type FragnoOutboxStreamingTransport = FragnoOutboxTransport & {
  stream(request: FragnoOutboxStreamRequest): Promise<void>;
};

export function isFragnoOutboxStreamingTransport(
  transport: FragnoOutboxTransport,
): transport is FragnoOutboxStreamingTransport {
  return "stream" in transport && typeof transport.stream === "function";
}

/** Uses paginated Fetch requests for catch-up and one NDJSON response for live entries. */
export function createFetchFragnoOutboxStreamingTransport(options: {
  internalUrl: string | URL;
  fetch?: typeof globalThis.fetch;
}): FragnoOutboxStreamingTransport {
  const fetch = options.fetch ?? globalThis.fetch;
  const catchUpTransport = createFetchFragnoOutboxTransport({
    internalUrl: options.internalUrl,
    fetch,
  });
  const streamUrl = createFragnoOutboxStreamUrl(options.internalUrl);

  return {
    ...catchUpTransport,
    async stream(request) {
      const response = await fetch(createFragnoOutboxRequestUrl(streamUrl, request), {
        signal: request.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Fragno outbox stream request failed: ${response.status} ${response.statusText}`,
        );
      }
      if (!response.body) {
        throw new Error("Fragno outbox stream response has no body.");
      }

      await consumeNdjsonOutboxStream(response.body, request);
    },
  };
}

export function createFragnoOutboxStreamUrl(internalUrl: string | URL): string {
  const url = new URL(internalUrl, getUrlBase());
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/outbox/stream`;
  return url.toString();
}

async function consumeNdjsonOutboxStream(
  body: ReadableStream<Uint8Array>,
  request: Pick<FragnoOutboxStreamRequest, "onEntry" | "signal">,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const cancelReader = () => {
    void reader.cancel(request.signal.reason).catch(() => {});
  };
  if (request.signal.aborted) {
    cancelReader();
  } else {
    request.signal.addEventListener("abort", cancelReader, { once: true });
  }

  try {
    while (!request.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        await consumeOutboxLine(line, request.onEntry);
      }
    }

    if (!request.signal.aborted) {
      buffer += decoder.decode();
      await consumeOutboxLine(buffer, request.onEntry);
    }
  } finally {
    request.signal.removeEventListener("abort", cancelReader);
    if (!completed) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}

async function consumeOutboxLine(
  line: string,
  onEntry: FragnoOutboxStreamRequest["onEntry"],
): Promise<void> {
  if (!line.trim()) {
    return;
  }

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error("Invalid JSON in Fragno outbox stream.", { cause: error });
  }

  if (!isFragnoOutboxEntry(value)) {
    throw new Error("Invalid Fragno outbox stream entry.");
  }

  await onEntry(value);
}

function isFragnoOutboxEntry(value: unknown): value is FragnoOutboxEntry {
  return (
    isRecord(value) &&
    typeof value["versionstamp"] === "string" &&
    typeof value["uowId"] === "string" &&
    "payload" in value &&
    (value["refMap"] === undefined || isRecord(value["refMap"]))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getUrlBase(): string | undefined {
  return typeof globalThis.location?.href === "string" ? globalThis.location.href : undefined;
}
