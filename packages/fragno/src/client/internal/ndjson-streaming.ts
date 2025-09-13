import type { StandardSchemaV1 } from "@standard-schema/spec";
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

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        try {
          const jsonObject = JSON.parse(line) as StandardSchemaV1.InferOutput<TOutputSchema>;
          items.push(jsonObject);

          if (firstItem === null) {
            firstItem = jsonObject;
            // We don't call store.setKey here for the first item
            // The caller will handle it via the return value

            // Start background streaming for remaining items and return the promise
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
        } catch (parseError) {
          throw new FragnoClientUnknownApiError("Failed to parse NDJSON line", 500, {
            cause: parseError,
          });
        }
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

  try {
    while (true) {
      // Check for abort signal before each read
      if (abortSignal?.aborted) {
        throw new FragnoClientFetchAbortError("Operation was aborted");
      }

      const { done, value } = await (abortSignal
        ? Promise.race([reader.read(), createAbortPromise(abortSignal)])
        : reader.read());

      if (done) {
        // Process any remaining buffer content
        if (buffer.trim()) {
          const lines = buffer.split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;

            try {
              const jsonObject = JSON.parse(line) as StandardSchemaV1.InferOutput<TOutputSchema>;
              items.push(jsonObject);
              store?.setData([...items]);
            } catch (parseError) {
              throw new FragnoClientUnknownApiError("Failed to parse NDJSON line", 400, {
                cause: parseError,
              });
            }
          }
        }
        break;
      }

      // Decode the chunk and add to buffer
      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const jsonObject = JSON.parse(line) as StandardSchemaV1.InferOutput<TOutputSchema>;
          items.push(jsonObject);
          store?.setData([...items]);
        } catch (parseError) {
          throw new FragnoClientUnknownApiError("Failed to parse NDJSON line", 400, {
            cause: parseError,
          });
        }
      }
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
