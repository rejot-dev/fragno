import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ContentlessStatusCode, StatusCode } from "../http/http-status";
import { ResponseStream } from "./internal/response-stream";
import type { InferOrUnknown } from "../util/types-util";

export type ResponseData = string | ArrayBuffer | ReadableStream | Uint8Array<ArrayBuffer>;

interface ResponseInit<T extends StatusCode = StatusCode> {
  headers?: HeadersInit;
  status?: T;
  statusText?: string;
}

/**
 * Utility function to merge headers from multiple sources.
 * Later headers override earlier ones.
 */
function mergeHeaders(...headerSources: (HeadersInit | undefined)[]): HeadersInit | undefined {
  const mergedHeaders = new Headers();

  for (const headerSource of headerSources) {
    if (!headerSource) {
      continue;
    }

    if (headerSource instanceof Headers) {
      for (const [key, value] of headerSource.entries()) {
        mergedHeaders.set(key, value);
      }
    } else if (Array.isArray(headerSource)) {
      for (const [key, value] of headerSource) {
        mergedHeaders.set(key, value);
      }
    } else {
      for (const [key, value] of Object.entries(headerSource)) {
        mergedHeaders.set(key, value);
      }
    }
  }

  return mergedHeaders;
}

export abstract class OutputContext<const TOutput, const TErrorCode extends string> {
  /**
   * Creates an error response.
   *
   * Shortcut for `throw new FragnoApiError(...)`
   */
  error = (
    { message, code }: { message: string; code: TErrorCode },
    initOrStatus?: ResponseInit | StatusCode,
    headers?: HeadersInit,
  ): Response => {
    if (typeof initOrStatus === "undefined") {
      return Response.json({ message: message, code }, { status: 500, headers });
    }

    if (typeof initOrStatus === "number") {
      return Response.json({ message: message, code }, { status: initOrStatus, headers });
    }

    const mergedHeaders = mergeHeaders(initOrStatus.headers, headers);
    return Response.json(
      { message: message, code },
      { status: initOrStatus.status, headers: mergedHeaders },
    );
  };

  empty = (
    initOrStatus?: ResponseInit<ContentlessStatusCode> | ContentlessStatusCode,
    headers?: HeadersInit,
  ): Response => {
    const defaultHeaders = {};

    if (typeof initOrStatus === "undefined") {
      const mergedHeaders = mergeHeaders(defaultHeaders, headers);
      return Response.json(null, {
        status: 201,
        headers: mergedHeaders,
      });
    }

    if (typeof initOrStatus === "number") {
      const mergedHeaders = mergeHeaders(defaultHeaders, headers);
      return Response.json(null, {
        status: initOrStatus,
        headers: mergedHeaders,
      });
    }

    const mergedHeaders = mergeHeaders(defaultHeaders, initOrStatus.headers, headers);
    return Response.json(null, {
      status: initOrStatus.status,
      headers: mergedHeaders,
    });
  };

  json = (
    object: TOutput,
    initOrStatus?: ResponseInit | StatusCode,
    headers?: HeadersInit,
  ): Response => {
    if (typeof initOrStatus === "undefined") {
      return Response.json(object, {
        status: 200,
        headers,
      });
    }

    if (typeof initOrStatus === "number") {
      return Response.json(object, {
        status: initOrStatus,
        headers,
      });
    }

    const mergedHeaders = mergeHeaders(initOrStatus.headers, headers);
    return Response.json(object, {
      status: initOrStatus.status,
      headers: mergedHeaders,
    });
  };

  jsonStream = (
    cb: (stream: ResponseStream<TOutput>) => void | Promise<void>,
    {
      onError,
      headers,
    }: {
      onError?: (error: Error, stream: ResponseStream<TOutput>) => void | Promise<void>;
      headers?: HeadersInit;
    } = {},
  ): Response => {
    // Note: this is intentionally an arrow function (=>) to keep `this` context.
    const defaultHeaders = {
      "content-type": "application/x-ndjson; charset=utf-8",
      "transfer-encoding": "chunked",
      "cache-control": "no-cache",
    };

    const { readable, writable } = new TransformStream();
    const stream = new ResponseStream(writable, readable);

    (async () => {
      try {
        await cb(stream);
      } catch (e) {
        if (e === undefined) {
          // If reading is canceled without a reason value (e.g. by StreamingApi)
          // then the .pipeTo() promise will reject with undefined.
          // In this case, do nothing because the stream is already closed.
        } else if (e instanceof Error && onError) {
          await onError(e, stream);
        } else {
          console.error(e);
        }
      } finally {
        stream.close();
      }
    })();

    return new Response(stream.responseReadable, {
      status: 200,
      headers: mergeHeaders(defaultHeaders, headers),
    });
  };
}

export class RequestOutputContext<
  const TOutputSchema extends StandardSchemaV1 | undefined = undefined,
  const TErrorCode extends string = string,
> extends OutputContext<InferOrUnknown<TOutputSchema>, TErrorCode> {
  // eslint-disable-next-line no-unused-private-class-members
  #outputSchema?: TOutputSchema;

  constructor(outputSchema?: TOutputSchema) {
    super();
    this.#outputSchema = outputSchema;
  }
}
