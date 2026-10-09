import type { z } from "zod";

import { backofficeApiErrorSchema, type BackofficeApiErrorCode } from "../errors";
import { backofficeApiV0 } from "./api";
import { backofficeScopePathSegment, type BackofficeContextScope } from "./shared/scope";

type Operations = typeof backofficeApiV0.operations;
type OperationId = keyof Operations;

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
  return {
    async call(scope, operationId, ...input) {
      const url = new URL(
        `/api/${backofficeApiV0.version}/scopes/${backofficeScopePathSegment(scope)}/${operationId}`,
        origin,
      );
      let response: Response;
      try {
        response = await fetch(
          url,
          input.length === 0
            ? { method: "POST", headers: { authorization: `Bearer ${accessToken}` } }
            : {
                method: "POST",
                headers: {
                  authorization: `Bearer ${accessToken}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify(input[0]),
              },
        );
      } catch (error) {
        throw new BackofficeApiUnreachableError(error);
      }
      if (!response.ok) {
        throw await requestErrorFromResponse(response);
      }
      // TypeScript cannot relate an indexed schema's result to `TId`; it is that operation's output.
      return backofficeApiV0.operations[operationId].output.parse(
        response.status === 204 ? undefined : await response.json(),
      ) as z.output<Operations[typeof operationId]["output"]>;
    },
  };
}
