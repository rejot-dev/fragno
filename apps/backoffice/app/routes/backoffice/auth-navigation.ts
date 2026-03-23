export const BACKOFFICE_HOME_PATH = "/backoffice";
export const BACKOFFICE_LOGIN_PATH = "/backoffice/login";
const BACKOFFICE_RETURN_TO_PARAM = "returnTo";

function isBackofficePath(pathname: string): boolean {
  return pathname === BACKOFFICE_HOME_PATH || pathname.startsWith(`${BACKOFFICE_HOME_PATH}/`);
}

export function sanitizeBackofficeReturnTo(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith(BACKOFFICE_HOME_PATH)) {
    return null;
  }

  let cleanedUrl: URL;
  try {
    cleanedUrl = new URL(trimmed, "http://localhost");
  } catch {
    return null;
  }

  if (!isBackofficePath(cleanedUrl.pathname)) {
    return null;
  }

  if (cleanedUrl.pathname === BACKOFFICE_LOGIN_PATH) {
    return BACKOFFICE_HOME_PATH;
  }

  return `${cleanedUrl.pathname}${cleanedUrl.search}`;
}

export function buildBackofficeLoginPath(returnTo?: string | null): string {
  const sanitizedReturnTo = sanitizeBackofficeReturnTo(returnTo);
  if (!sanitizedReturnTo || sanitizedReturnTo === BACKOFFICE_HOME_PATH) {
    return BACKOFFICE_LOGIN_PATH;
  }

  const searchParams = new URLSearchParams();
  searchParams.set(BACKOFFICE_RETURN_TO_PARAM, sanitizedReturnTo);
  return `${BACKOFFICE_LOGIN_PATH}?${searchParams.toString()}`;
}

export function readBackofficeReturnTo(url: URL | string): string {
  const resolvedUrl = typeof url === "string" ? new URL(url, "http://localhost") : url;
  return (
    sanitizeBackofficeReturnTo(resolvedUrl.searchParams.get(BACKOFFICE_RETURN_TO_PARAM)) ??
    BACKOFFICE_HOME_PATH
  );
}
