/**
 * Discriminated union representing all possible Fragno response types
 */
export type FragnoResponse<T> =
  | {
      type: "empty";
      status: number;
      headers: Headers;
    }
  | {
      type: "error";
      status: number;
      headers: Headers;
      error: { message: string; code: string };
    }
  | {
      type: "json";
      status: number;
      headers: Headers;
      data: T;
    }
  | {
      type: "jsonStream";
      status: number;
      headers: Headers;
      stream: AsyncGenerator<T extends unknown[] ? T[number] : T>;
    };

/**
 * Parse a Response object into a FragnoResponse discriminated union
 */
export async function parseFragnoResponse<T>(response: Response): Promise<FragnoResponse<T>> {
  const status = response.status;
  const headers = response.headers;
  const contentType = headers.get("content-type") || "";

  // Check for streaming response
  if (contentType.includes("application/x-ndjson")) {
    return {
      type: "jsonStream",
      status,
      headers,
      stream: parseNDJSONStream<T>(response),
    };
  }

  // Parse JSON body
  const text = await response.text();

  // Empty response
  if (!text || text === "null") {
    return {
      type: "empty",
      status,
      headers,
    };
  }

  const data = JSON.parse(text);

  // Error response (has message and code, or error and code)
  if (data && typeof data === "object" && "code" in data) {
    if ("message" in data) {
      return {
        type: "error",
        status,
        headers,
        error: { message: data.message, code: data.code },
      };
    }
    if ("error" in data) {
      return {
        type: "error",
        status,
        headers,
        error: { message: data.error, code: data.code },
      };
    }
  }

  // JSON response
  return {
    type: "json",
    status,
    headers,
    data: data as T,
  };
}

/**
 * Parse an NDJSON stream into an async generator
 */
async function* parseNDJSONStream<T>(
  response: Response,
): AsyncGenerator<T extends unknown[] ? T[number] : T> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let completed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        completed = true;
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      let lineStart = 0;
      let newlineIndex = chunk.indexOf("\n");

      if (buffer.length === 0 && newlineIndex === chunk.length - 1) {
        // ResponseStream writes one frame per chunk in-process. JSON.parse accepts the trailing
        // newline, so this path avoids split-array allocation and partial-frame bookkeeping.
        if (/\S/u.test(chunk)) {
          yield JSON.parse(chunk) as T extends unknown[] ? T[number] : T;
        }
        continue;
      }

      if (buffer.length > 0) {
        if (newlineIndex === -1) {
          buffer += chunk;
          continue;
        }
        const completedLine = buffer + chunk.slice(0, newlineIndex);
        buffer = "";
        if (/\S/u.test(completedLine)) {
          yield JSON.parse(completedLine) as T extends unknown[] ? T[number] : T;
        }
        lineStart = newlineIndex + 1;
        newlineIndex = chunk.indexOf("\n", lineStart);
      }

      while (newlineIndex !== -1) {
        const line = chunk.slice(lineStart, newlineIndex);
        if (/\S/u.test(line)) {
          yield JSON.parse(line) as T extends unknown[] ? T[number] : T;
        }
        lineStart = newlineIndex + 1;
        newlineIndex = chunk.indexOf("\n", lineStart);
      }
      buffer = chunk.slice(lineStart);
    }

    const decoderTail = decoder.decode();
    if (decoderTail.length > 0) {
      buffer += decoderTail;
    }
    if (/\S/u.test(buffer)) {
      yield JSON.parse(buffer) as T extends unknown[] ? T[number] : T;
    }
  } finally {
    if (!completed) {
      await reader.cancel();
    }
    reader.releaseLock();
  }
}
