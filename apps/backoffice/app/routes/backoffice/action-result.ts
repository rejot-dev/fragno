export type RouteActionResponse =
  | { type: "json"; status: number; data?: unknown }
  | { type: "error"; status: number; error: { message: string } }
  | { type: string; status: number };

export type BooleanActionResult = {
  ok: boolean;
  error: string | null;
};

export type NullableDataActionResult<T> = {
  result: T | null;
  error: string | null;
};

const isSuccessStatus = (status: number) => status >= 200 && status < 300;
const routeResponseOk = (data: unknown): boolean =>
  Boolean(data && typeof data === "object" && "ok" in data && data.ok);

export const booleanActionResultFromRouteResponse = ({
  response,
  failureMessage,
  requireSuccessStatus = false,
}: {
  response: RouteActionResponse;
  failureMessage: string;
  requireSuccessStatus?: boolean;
}): BooleanActionResult => {
  if (
    response.type === "json" &&
    "data" in response &&
    (!requireSuccessStatus || isSuccessStatus(response.status))
  ) {
    return { ok: routeResponseOk(response.data), error: null };
  }

  if (response.type === "error" && "error" in response) {
    return { ok: false, error: response.error.message };
  }

  return { ok: false, error: `${failureMessage} (${response.status}).` };
};

export const booleanActionResultFromCaughtError = (
  error: unknown,
  fallback: string,
): BooleanActionResult => ({
  ok: false,
  error: error instanceof Error ? error.message : fallback,
});

export const nullableDataActionResultFromRouteResponse = <TData>({
  response,
  failureMessage,
}: {
  response: RouteActionResponse;
  failureMessage: string;
}): NullableDataActionResult<TData> => {
  if (response.type === "json" && "data" in response) {
    return { result: response.data as TData, error: null };
  }

  if (response.type === "error" && "error" in response) {
    return { result: null, error: response.error.message };
  }

  return { result: null, error: `${failureMessage} (${response.status}).` };
};

export const nullableDataActionResultFromCaughtError = <TData>(
  error: unknown,
  fallback: string,
): NullableDataActionResult<TData> => ({
  result: null,
  error: error instanceof Error ? error.message : fallback,
});
