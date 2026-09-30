const CODEMODE_AUTHENTICATION_ERROR_CONTENT_TYPE =
  "application/vnd.fragno.codemode-authentication-error+json";

export type CodemodeHttpAuthenticationErrorCode =
  | "AUTHENTICATION_FAILED"
  | "AUTHENTICATION_NOT_CONFIGURED";

type CodemodeHttpAuthenticationErrorResponse = {
  code: CodemodeHttpAuthenticationErrorCode;
  message: string;
};

/** Stable authentication failure returned by codemode HTTP clients. */
export class CodemodeHttpAuthenticationError extends Error {
  readonly code: CodemodeHttpAuthenticationErrorCode;

  constructor(code: CodemodeHttpAuthenticationErrorCode, message: string) {
    super(message);
    this.name = "CodemodeHttpAuthenticationError";
    this.code = code;
  }
}

function createCodemodeHttpAuthenticationErrorResponse(
  code: CodemodeHttpAuthenticationErrorCode,
  message: string,
  status: 401 | 503,
): Response {
  return Response.json({ code, message } satisfies CodemodeHttpAuthenticationErrorResponse, {
    status,
    headers: { "content-type": CODEMODE_AUTHENTICATION_ERROR_CONTENT_TYPE },
  });
}

/** Parses only authoritative codemode authentication responses, leaving proxy failures untouched. */
export async function readCodemodeHttpAuthenticationError(
  response: Response,
): Promise<CodemodeHttpAuthenticationError | null> {
  if (response.headers.get("content-type") !== CODEMODE_AUTHENTICATION_ERROR_CONTENT_TYPE) {
    return null;
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const code = (value as Record<string, unknown>).code;
  const message = (value as Record<string, unknown>).message;
  if (
    (code !== "AUTHENTICATION_FAILED" && code !== "AUTHENTICATION_NOT_CONFIGURED") ||
    typeof message !== "string"
  ) {
    return null;
  }
  return new CodemodeHttpAuthenticationError(code, message);
}

/** Compares a request bearer token with the configured bridge token in constant time. */
export async function hasExpectedBearerAuthorization(
  request: Request,
  apiKey: string,
): Promise<boolean> {
  const authorization = request.headers.get("authorization") ?? "";
  const [expected, actual] = await Promise.all(
    [`Bearer ${apiKey}`, authorization].map((value) =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
  const expectedBytes = new Uint8Array(expected);
  const actualBytes = new Uint8Array(actual);
  let difference = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= expectedBytes[index] ^ actualBytes[index];
  }
  return difference === 0;
}

/** Returns an HTTP error response unless the request carries the configured codemode bearer token. */
export async function authenticateCodemodeHttpRequest(
  request: Request,
  apiKey: string | undefined,
): Promise<Response | null> {
  if (!apiKey) {
    return createCodemodeHttpAuthenticationErrorResponse(
      "AUTHENTICATION_NOT_CONFIGURED",
      "Codemode HTTP authentication is not configured.",
      503,
    );
  }
  return (await hasExpectedBearerAuthorization(request, apiKey))
    ? null
    : createCodemodeHttpAuthenticationErrorResponse(
        "AUTHENTICATION_FAILED",
        "Codemode HTTP authentication failed.",
        401,
      );
}
