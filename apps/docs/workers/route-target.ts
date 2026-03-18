const BACKOFFICE_PATH_PREFIXES = [
  "/backoffice",
  "/__dev/workers",
  "/api/cloudflare",
  "/api/resend",
  "/api/telegram",
  "/api/otp",
  "/api/github",
  "/api/upload",
  "/api/pi",
  "/api/automations",
  "/api/workflows",
] as const;

function normalizePathname(pathname: string) {
  const trimmedPathname = pathname.trim();

  if (trimmedPathname.length === 0) {
    return "/";
  }

  const normalizedPathname = trimmedPathname.startsWith("/")
    ? trimmedPathname
    : `/${trimmedPathname}`;

  return normalizedPathname.replace(/\/+/gu, "/");
}

export function isBackofficeRequest(requestOrUrl: Request | URL | string) {
  const url = new URL(requestOrUrl instanceof Request ? requestOrUrl.url : requestOrUrl);
  const pathname = normalizePathname(url.pathname);

  return BACKOFFICE_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
