export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export const createOrganisationNotConfiguredMessage = (serviceName: string) =>
  `${serviceName} is not configured for this organisation.`;

export const isSuccessStatus = (status: number) => status >= 200 && status < 300;

export const getJsonErrorField = (value: unknown, field: "message" | "code") => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const resolved = (value as Record<string, unknown>)[field];
  return typeof resolved === "string" && resolved.trim() ? resolved : null;
};

type RouteErrorResponse =
  | ({ type: string; status: number } & { type: "error"; error: unknown })
  | ({ type: string; status: number } & { type: "json"; data: unknown })
  | { type: string; status: number };

const getRouteErrorInfo = (response: RouteErrorResponse) => {
  if ("error" in response) {
    return {
      code: getJsonErrorField(response.error, "code"),
      message: getJsonErrorField(response.error, "message"),
    };
  }

  if ("data" in response) {
    return {
      code: getJsonErrorField(response.data, "code"),
      message: getJsonErrorField(response.data, "message"),
    };
  }

  return {
    code: null,
    message: null,
  };
};

export const throwOnRouteRuntimeError = (
  response: RouteErrorResponse,
  options: {
    runtimeLabel: string;
    label: string;
    notConfiguredMessage?: string;
  },
): never => {
  const { code, message } = getRouteErrorInfo(response);

  if (response.status === 400 && code === "NOT_CONFIGURED") {
    throw new NotConfiguredError(
      message ?? options.notConfiguredMessage ?? "Service is not configured.",
    );
  }

  if (message) {
    throw new Error(`${options.runtimeLabel} returned ${response.status}: ${message}`);
  }

  throw new Error(`${options.runtimeLabel} returned ${response.status} (${options.label})`);
};

const readResponseErrorInfo = async (response: Response) => {
  let payload: unknown = null;
  let rawBody: string | null = null;

  try {
    rawBody = await response.text();
    if (rawBody.trim()) {
      try {
        payload = JSON.parse(rawBody);
      } catch {
        payload = null;
      }
    }
  } catch {
    rawBody = null;
  }

  const jsonMessage = getJsonErrorField(payload, "message");

  return {
    code: getJsonErrorField(payload, "code"),
    message: jsonMessage ?? (payload === null ? (rawBody?.trim() ?? null) : null),
  };
};

export const throwOnHttpResponseError = async (
  response: Response,
  options: {
    runtimeLabel: string;
    label: string;
    notConfiguredMessage?: string;
  },
): Promise<never> => {
  const { code, message } = await readResponseErrorInfo(response);

  if (response.status === 400 && code === "NOT_CONFIGURED") {
    throw new NotConfiguredError(
      message ?? options.notConfiguredMessage ?? "Service is not configured.",
    );
  }

  if (message) {
    throw new Error(`${options.runtimeLabel} returned ${response.status}: ${message}`);
  }

  throw new Error(`${options.runtimeLabel} returned ${response.status} (${options.label})`);
};
