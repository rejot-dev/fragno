import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { StatusCode } from "../../http/http-status";
import {
  FragnoClientError,
  FragnoClientFetchError,
  FragnoClientFetchAbortError,
  FragnoClientUnknownApiError,
} from "../client-error";

/**
 * Creates a promise that rejects when the abort signal is triggered
 */
function createAbortPromise(abortSignal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    const abortHandler = () => {
      reject(new FragnoClientFetchAbortError("Operation was aborted"));
    };

    if (abortSignal.aborted) {
      abortHandler();
    } else {
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

/**
 * Result of NDJSON streaming that includes the first item and a promise for the streaming continuation
 */
export interface NdjsonStreamingResult<T> {
  firstItem: T;
  streamingPromise: Promise<T[]>;
}

export interface NdjsonStreamingStore<
  TOutputSchema extends StandardSchemaV1,
  TErrorCode extends string,
> {
  setData(value: StandardSchemaV1.InferOutput<TOutputSchema>): void;
  setError(value: FragnoClientError<TErrorCode>): void;
}

type NdjsonParseResult = {
  buffer: string;
  stopped: boolean;
};

const parseNdjsonBuffer = <T>(
  buffer: string,
  options: {
    flush?: boolean;
    parseErrorStatus: StatusCode;
    onItem: (item: T) => boolean | void;
  },
): NdjsonParseResult => {
  const lines = buffer.split("\n");
  const trailingBuffer = options.flush ? "" : (lines.pop() ?? "");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }

    let jsonObject: T;
    try {
      jsonObject = JSON.parse(line) as T;
    } catch (parseError) {
      throw new FragnoClientUnknownApiError(
        "Failed to parse NDJSON line",
        options.parseErrorStatus,
        { cause: parseError },
      );
    }

    if (options.onItem(jsonObject) === false) {
      const remainingLines = lines.slice(index + 1);
      return {
        stopped: true,
        buffer:
          remainingLines.length > 0
            ? `${remainingLines.join("\n")}\n${trailingBuffer}`
            : trailingBuffer,
      };
    }
  }

  return { stopped: false, buffer: trailingBuffer };
};

/**
 * Handles NDJSON streaming responses by returning the first item from the fetcher
 * and then continuing to stream updates via the store's mutate method.
 *
 * This makes it so that we can wait until the first chunk before updating the store, if we did
 * not do this, `loading` would briefly be false before the first item would be populated in the
 * result.
 *
 * @param response - The fetch Response object containing the NDJSON stream
 * @param store - The fetcher store to update with streaming data
 * @param abortSignal - Optional AbortSignal to cancel the streaming operation
 * @returns A promise that resolves to an object containing the first item and a streaming promise
 */
export async function handleNdjsonStreamingFirstItem<
  TOutputSchema extends StandardSchemaV1,
  TErrorCode extends string,
>(
  response: Response,
  store?: NdjsonStreamingStore<TOutputSchema, TErrorCode>,
  options: { abortSignal?: AbortSignal } = {},
): Promise<NdjsonStreamingResult<StandardSchemaV1.InferOutput<TOutputSchema>>> {
  if (!response.body) {
    throw new FragnoClientFetchError("Streaming response has no body", "NO_BODY");
  }

  const { abortSignal } = options;

  if (abortSignal?.aborted) {
    throw new FragnoClientFetchAbortError("Operation was aborted");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let firstItem: StandardSchemaV1.InferOutput<TOutputSchema> | null = null;
  const items: StandardSchemaV1.InferOutput<TOutputSchema>[] = [];

  try {
    // Read until we get the first item
    while (firstItem === null) {
      // Check for abort signal before each read
      if (abortSignal?.aborted) {
        reader.releaseLock();
        throw new FragnoClientFetchAbortError("Operation was aborted");
      }

      const { done, value } = await (abortSignal
        ? Promise.race([reader.read(), createAbortPromise(abortSignal)])
        : reader.read());

      if (done) {
        break;
      }

      // Decode the chunk and add to buffer
      buffer += decoder.decode(value, { stream: true });

      const parseResult = parseNdjsonBuffer<StandardSchemaV1.InferOutput<TOutputSchema>>(buffer, {
        parseErrorStatus: 500,
        onItem: (jsonObject) => {
          items.push(jsonObject);
          firstItem = jsonObject;
          return false;
        },
      });
      buffer = parseResult.buffer;

      if (firstItem !== null) {
        // We don't call store.setKey here for the first item. The caller will handle it via the
        // fetcher return value. Any complete lines already read after the first item are preserved
        // in `buffer` and processed by the background continuation.
        const streamingPromise = continueStreaming(
          reader,
          decoder,
          buffer,
          items,
          store,
          abortSignal,
        );
        return {
          firstItem,
          streamingPromise,
        };
      }
    }

    // If we get here and haven't returned a first item, the stream was empty
    if (firstItem === null) {
      reader.releaseLock();
      throw new FragnoClientUnknownApiError("NDJSON stream contained no valid items", 500);
    }

    // This should never be reached, but TypeScript needs it
    reader.releaseLock();
    throw new FragnoClientFetchError("Unexpected end of stream processing", "NO_BODY");
  } catch (error) {
    // Handle errors during streaming
    if (error instanceof FragnoClientError) {
      store?.setError(error);
      throw error;
    } else {
      // TODO: Not sure about the typing here
      const clientError = new FragnoClientUnknownApiError("Unknown streaming error", 500, {
        cause: error,
      }) as unknown as FragnoClientError<TErrorCode>;
      store?.setError(clientError);
      throw clientError;
    }
  }
}

/**
 * Continues streaming the remaining items in the background
 */
// FIXME: Shitty code
async function continueStreaming<TOutputSchema extends StandardSchemaV1, TErrorCode extends string>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  initialBuffer: string,
  items: StandardSchemaV1.InferOutput<TOutputSchema>[],
  store?: NdjsonStreamingStore<TOutputSchema, TErrorCode>,
  abortSignal?: AbortSignal,
): Promise<StandardSchemaV1.InferOutput<TOutputSchema>[]> {
  let buffer = initialBuffer;

  const appendItem = (jsonObject: StandardSchemaV1.InferOutput<TOutputSchema>) => {
    items.push(jsonObject);
    store?.setData([...items]);
  };

  try {
    while (true) {
      buffer = parseNdjsonBuffer<StandardSchemaV1.InferOutput<TOutputSchema>>(buffer, {
        parseErrorStatus: 400,
        onItem: appendItem,
      }).buffer;

      // Check for abort signal before each read
      if (abortSignal?.aborted) {
        throw new FragnoClientFetchAbortError("Operation was aborted");
      }

      const { done, value } = await (abortSignal
        ? Promise.race([reader.read(), createAbortPromise(abortSignal)])
        : reader.read());

      if (done) {
        parseNdjsonBuffer<StandardSchemaV1.InferOutput<TOutputSchema>>(buffer, {
          flush: true,
          parseErrorStatus: 400,
          onItem: appendItem,
        });
        break;
      }

      // Decode the chunk and add to buffer
      buffer += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (error instanceof FragnoClientError) {
      store?.setError(error);
    } else {
      const clientError = new FragnoClientUnknownApiError("Unknown streaming error", 400, {
        cause: error,
      }) as unknown as FragnoClientError<TErrorCode>;
      store?.setError(clientError);
      throw clientError;
    }

    throw error;
  } finally {
    reader.releaseLock();
  }

  return items;
}
