import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ContentlessStatusCode, StatusCode } from "../http/http-status";
import { StreamingApi } from "./internal/response-stream";

export type ResponseData = string | ArrayBuffer | ReadableStream | Uint8Array<ArrayBuffer>;

interface ResponseInit<T extends StatusCode = StatusCode> {
  headers?: HeadersInit;
  status?: T;
  statusText?: string;
}

type InferOrUnknown<T> =
  T extends NonNullable<StandardSchemaV1>
    ? StandardSchemaV1.InferOutput<T>
    : T extends undefined
      ? unknown
      : unknown;

export class RequestOutputContext<
  TOutputSchema extends StandardSchemaV1 | undefined = undefined,
  TErrorCode extends string = string,
> {
  // eslint-disable-next-line no-unused-private-class-members
  #outputSchema?: TOutputSchema;

  constructor(outputSchema?: TOutputSchema) {
    this.#outputSchema = outputSchema;
  }

  /**
   * Creates an error response.
   *
   * Shortcut for `throw new FragnoApiError(...)`
   */
  error(
    { message, code }: { message: string; code: TErrorCode },
    initOrStatus?: ResponseInit | StatusCode,
    headers?: HeadersInit,
  ): Response {
    if (typeof initOrStatus === "undefined") {
      return Response.json({ error: message, code }, { status: 500, headers });
    }

    if (typeof initOrStatus === "number") {
      return Response.json({ error: message, code }, { status: initOrStatus, headers });
    }

    return Response.json(
      { error: message, code },
      { status: initOrStatus.status, headers: initOrStatus.headers },
    );
  }

  empty(
    initOrStatus?: ResponseInit<ContentlessStatusCode> | ContentlessStatusCode,
    headers?: HeadersInit,
  ): Response {
    if (typeof initOrStatus === "undefined") {
      return Response.json(null, {
        status: 201,
        headers,
      });
    }

    if (typeof initOrStatus === "number") {
      return Response.json(null, {
        status: initOrStatus,
        headers,
      });
    }

    return Response.json(null, {
      status: initOrStatus.status,
      headers: initOrStatus.headers,
    });
  }

  json(
    object: InferOrUnknown<TOutputSchema>,
    initOrStatus?: ResponseInit | StatusCode,
    headers?: HeadersInit,
  ): Response {
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

    let mergedHeaders: HeadersInit | undefined;
    if (initOrStatus.headers && headers) {
      mergedHeaders = new Headers(initOrStatus.headers);
      for (const [key, value] of Object.entries(headers)) {
        mergedHeaders.set(key, value);
      }
    } else {
      mergedHeaders = initOrStatus.headers ?? headers;
    }

    return Response.json(object, {
      status: initOrStatus.status,
      headers: mergedHeaders,
    });
  }

  stream(
    cb: (stream: StreamingApi) => void | Promise<void>,
    onError?: (error: Error, stream: StreamingApi) => void | Promise<void>,
  ): Response {
    const { readable, writable } = new TransformStream();
    const stream = new StreamingApi(writable, readable);

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

    return new Response(stream.responseReadable);
  }
}
