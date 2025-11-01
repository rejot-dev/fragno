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

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");

      // Keep the last incomplete line in the buffer
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          yield JSON.parse(line) as T extends unknown[] ? T[number] : T;
        }
      }
    }

    // Process any remaining data in the buffer
    if (buffer.trim()) {
      yield JSON.parse(buffer) as T extends unknown[] ? T[number] : T;
    }
  } finally {
    reader.releaseLock();
  }
}
