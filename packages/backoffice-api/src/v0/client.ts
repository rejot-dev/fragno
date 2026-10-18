import type { z } from "zod";

import { backofficeApiErrorSchema, type BackofficeApiErrorCode } from "../errors";
import { backofficeApiV0 } from "./api";
import {
  backofficeProvisioningOperations,
  type BackofficeProvisioningOperationId,
} from "./provisioning";
import { backofficeScopePathSegment, type BackofficeContextScope } from "./shared/scope";

type Operations = typeof backofficeApiV0.operations;
type OperationId = keyof Operations;
type Streams = typeof backofficeApiV0.streams;
type StreamId = keyof Streams;

/** Operations whose input is `z.void()` are called without an input argument. */
type OperationInputArgs<TId extends OperationId> = Operations[TId]["input"] extends z.ZodVoid
  ? []
  : [input: z.input<Operations[TId]["input"]>];

export type BackofficeApiClient = {
  /** Runs one operation in `scope`, returning its output parsed by the operation's schema. */
  call<TId extends OperationId>(
    scope: BackofficeContextScope,
    operationId: TId,
    ...input: OperationInputArgs<TId>
  ): Promise<z.output<Operations[TId]["output"]>>;
  /**
   * Opens one stream in `scope` and yields its frames, each parsed by the stream's frame schema.
   * Leaving the loop closes the connection; the iteration ends when Backoffice ends the stream.
   */
  watch<TId extends StreamId>(
    scope: BackofficeContextScope,
    streamId: TId,
    input: z.input<Streams[TId]["input"]>,
  ): AsyncIterable<z.output<Streams[TId]["frame"]>>;
};

/**
 * Backoffice answered with an error. `code` is null when the response was not an API error, e.g.
 * a server failure or an intermediary's response, so the operation's outcome is unknown.
 */
export class BackofficeApiRequestError extends Error {
  readonly status: number;
  readonly code: BackofficeApiErrorCode | null;

  constructor(status: number, code: BackofficeApiErrorCode | null, message: string) {
    super(message);
    this.name = "BackofficeApiRequestError";
    this.status = status;
    this.code = code;
  }
}

/** The request never got a response, e.g. a network failure, so the operation's outcome is unknown. */
export class BackofficeApiUnreachableError extends Error {
  constructor(cause: unknown) {
    super("Backoffice could not be reached.", { cause });
    this.name = "BackofficeApiUnreachableError";
  }
}

async function requestErrorFromResponse(response: Response): Promise<BackofficeApiRequestError> {
  const body = backofficeApiErrorSchema.safeParse(await response.json().catch(() => null));
  return body.success
    ? new BackofficeApiRequestError(response.status, body.data.error.code, body.data.error.message)
    : new BackofficeApiRequestError(
        response.status,
        null,
        `Backoffice responded with HTTP ${response.status}.`,
      );
}

/**
 * Calls the v0 API at `origin` with one bearer credential. Network failures reject with
 * `BackofficeApiUnreachableError`, and error responses with `BackofficeApiRequestError`. Anything
 * else, such as a success body that does not match this contract, is a bug and rejects as is.
 */
export function createBackofficeApiClient({
  origin,
  accessToken,
  fetch,
}: {
  origin: string;
  accessToken: string;
  fetch: typeof globalThis.fetch;
}): BackofficeApiClient {
  async function request(
    scope: BackofficeContextScope,
    id: OperationId | StreamId,
    input: [] | [unknown],
    signal: AbortSignal | null,
  ): Promise<Response> {
    const url = new URL(
      `/api/${backofficeApiV0.version}/scopes/${backofficeScopePathSegment(scope)}/${id}`,
      origin,
    );
    let response: Response;
    try {
      response = await fetch(
        url,
        input.length === 0
          ? { method: "POST", headers: { authorization: `Bearer ${accessToken}` }, signal }
          : {
              method: "POST",
              headers: {
                authorization: `Bearer ${accessToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(input[0]),
              signal,
            },
      );
    } catch (error) {
      throw new BackofficeApiUnreachableError(error);
    }
    if (!response.ok) {
      throw await requestErrorFromResponse(response);
    }
    return response;
  }

  return {
    async call(scope, operationId, ...input) {
      const response = await request(scope, operationId, input, null);
      // TypeScript cannot relate an indexed schema's result to `TId`; it is that operation's output.
      return backofficeApiV0.operations[operationId].output.parse(
        response.status === 204 ? undefined : await response.json(),
      ) as z.output<Operations[typeof operationId]["output"]>;
    },
    async *watch(scope, streamId, input) {
      const abort = new AbortController();
      const response = await request(scope, streamId, [input], abort.signal);
      const frame = backofficeApiV0.streams[streamId].frame;
      const lines = response
        .body!.pipeThrough(new TextDecoderStream())
        .pipeThrough(splitLines())
        .getReader();
      try {
        while (true) {
          let next: ReadableStreamReadResult<string>;
          try {
            next = await lines.read();
          } catch (error) {
            throw new BackofficeApiUnreachableError(error);
          }
          if (next.done) {
            return;
          }
          // TypeScript cannot relate an indexed schema's result to `TId`; it is that stream's frame.
          yield frame.parse(JSON.parse(next.value)) as z.output<Streams[typeof streamId]["frame"]>;
        }
      } finally {
        // Leaving the loop early must not keep the connection open.
        abort.abort();
      }
    },
  };
}

/** Splits newline-delimited text into its non-empty lines. */
function splitLines(): TransformStream<string, string> {
  let buffered = "";
  return new TransformStream({
    transform(chunk, controller) {
      const lines = (buffered + chunk).split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() !== "") {
          controller.enqueue(line);
        }
      }
    },
    flush(controller) {
      if (buffered.trim() !== "") {
        controller.enqueue(buffered);
      }
    },
  });
}

type ProvisioningOperations = typeof backofficeProvisioningOperations;

export type BackofficeProvisioningClient = {
  /** Runs one provisioning operation, returning its output parsed by the operation's schema. */
  call<TId extends BackofficeProvisioningOperationId>(
    operationId: TId,
    input: z.input<ProvisioningOperations[TId]["input"]>,
  ): Promise<z.output<ProvisioningOperations[TId]["output"]>>;
};

/**
 * Calls the provisioning API at `origin` with a first-party app's client-credentials token. Fails
 * like `createBackofficeApiClient`; every operation is idempotent, so a call whose outcome is
 * unknown can be repeated.
 */
export function createBackofficeProvisioningClient({
  origin,
  accessToken,
  fetch,
}: {
  origin: string;
  accessToken: string;
  fetch: typeof globalThis.fetch;
}): BackofficeProvisioningClient {
  return {
    async call(operationId, input) {
      const url = new URL(`/api/${backofficeApiV0.version}/provisioning/${operationId}`, origin);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify(input),
        });
      } catch (error) {
        throw new BackofficeApiUnreachableError(error);
      }
      if (!response.ok) {
        throw await requestErrorFromResponse(response);
      }
      // TypeScript cannot relate an indexed schema's result to `TId`; it is that operation's output.
      return backofficeProvisioningOperations[operationId].output.parse(
        await response.json(),
      ) as z.output<ProvisioningOperations[typeof operationId]["output"]>;
    },
  };
}
