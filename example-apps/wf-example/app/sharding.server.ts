import { SHARD_COOKIE_NAME } from "./sharding";

const SHARD_HEADER = "x-fragno-shard";

function parseCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = trimmed.slice(0, index);
    if (key !== name) {
      continue;
    }
    const value = trimmed.slice(index + 1);
    return decodeURIComponent(value);
  }

  return null;
}

export function getShardFromHeaders(headers: Headers): string | null {
  const headerValue = headers.get(SHARD_HEADER);
  if (headerValue) {
    const trimmed = headerValue.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  const cookieValue = parseCookie(headers.get("cookie"), SHARD_COOKIE_NAME);
  if (cookieValue) {
    const trimmed = cookieValue.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return null;
}

export function getShardFromRequest(request: Request): string | null {
  return getShardFromHeaders(request.headers);
}

export { SHARD_HEADER };
