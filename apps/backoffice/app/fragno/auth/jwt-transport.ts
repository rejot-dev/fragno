import { readBackofficeAccessTokenCookie } from "./token-lifecycle";

export type ResolvedBackofficeJwtTransport =
  | { ok: true; transport: "bearer" | "cookie"; token: string }
  | { ok: false; reason: "missing" | "invalid" };

export const resolveBackofficeJwtTransport = (request: Request): ResolvedBackofficeJwtTransport => {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer\s+([^\s]+)$/iu.exec(authorization.trim());
    return match?.[1]
      ? { ok: true, transport: "bearer", token: match[1] }
      : { ok: false, reason: "invalid" };
  }

  const token = readBackofficeAccessTokenCookie(request.headers.get("cookie"));
  return token ? { ok: true, transport: "cookie", token } : { ok: false, reason: "missing" };
};
