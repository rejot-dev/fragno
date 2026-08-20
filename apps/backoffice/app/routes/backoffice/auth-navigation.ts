export const BACKOFFICE_HOME_PATH = "/backoffice";
export const BACKOFFICE_LOGIN_PATH = "/backoffice/login";
export const BACKOFFICE_SIGN_UP_PATH = "/backoffice/sign-up";
export const BACKOFFICE_AUTH_BOOTSTRAP_PATH = "/backoffice/auth/bootstrap";
export const BACKOFFICE_SESSION_ENTRY_PATH = "/api/auth/backoffice-entry";
const BACKOFFICE_RETURN_TO_PARAM = "returnTo";
const BACKOFFICE_ORGANIZATION_ID_PARAM = "organizationId";

function isBackofficePath(pathname: string): boolean {
  return pathname === BACKOFFICE_HOME_PATH || pathname.startsWith(`${BACKOFFICE_HOME_PATH}/`);
}

function isScopedFragmentOAuthCallbackPath(pathname: string): boolean {
  return /^\/api\/(?:mcp|http)\/[^/]+\/oauth\/callback$/.test(pathname);
}

function isAllowedBackofficeReturnToPath(pathname: string): boolean {
  return isBackofficePath(pathname) || isScopedFragmentOAuthCallbackPath(pathname);
}

export function sanitizeBackofficeReturnTo(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (
    !trimmed.startsWith(BACKOFFICE_HOME_PATH) &&
    !trimmed.startsWith("/api/mcp/") &&
    !trimmed.startsWith("/api/http/")
  ) {
    return null;
  }

  let cleanedUrl: URL;
  try {
    cleanedUrl = new URL(trimmed, "http://localhost");
  } catch {
    return null;
  }

  if (!isAllowedBackofficeReturnToPath(cleanedUrl.pathname)) {
    return null;
  }

  if (cleanedUrl.pathname === BACKOFFICE_LOGIN_PATH) {
    return BACKOFFICE_HOME_PATH;
  }

  return `${cleanedUrl.pathname}${cleanedUrl.search}`;
}

const buildBackofficeAuthPath = (path: string, returnTo?: string | null): string => {
  const sanitizedReturnTo = sanitizeBackofficeReturnTo(returnTo);
  if (!sanitizedReturnTo || sanitizedReturnTo === BACKOFFICE_HOME_PATH) {
    return path;
  }

  const searchParams = new URLSearchParams();
  searchParams.set(BACKOFFICE_RETURN_TO_PARAM, sanitizedReturnTo);
  return `${path}?${searchParams.toString()}`;
};

export function buildBackofficeLoginPath(returnTo?: string | null): string {
  return buildBackofficeAuthPath(BACKOFFICE_LOGIN_PATH, returnTo);
}

export function buildBackofficeSignUpPath(returnTo?: string | null): string {
  return buildBackofficeAuthPath(BACKOFFICE_SIGN_UP_PATH, returnTo);
}

export function buildBackofficeAuthBootstrapPath(returnTo?: string | null): string {
  return buildBackofficeAuthPath(BACKOFFICE_AUTH_BOOTSTRAP_PATH, returnTo);
}

export function buildBackofficeSessionEntryPath(returnTo?: string | null): string {
  return buildBackofficeAuthPath(BACKOFFICE_SESSION_ENTRY_PATH, returnTo);
}

/** Exchanges the browser JWT for the destination organization before opening the return path. */
export function buildBackofficeOrganizationSwitchPath(
  organizationId: string,
  returnTo: string,
): string {
  const sanitizedOrganizationId = organizationId.trim();
  if (!sanitizedOrganizationId) {
    throw new Error("Backoffice organization switch requires an organization id.");
  }

  const searchParams = new URLSearchParams();
  searchParams.set(BACKOFFICE_ORGANIZATION_ID_PARAM, sanitizedOrganizationId);
  searchParams.set(
    BACKOFFICE_RETURN_TO_PARAM,
    sanitizeBackofficeReturnTo(returnTo) ?? BACKOFFICE_HOME_PATH,
  );
  return `${BACKOFFICE_AUTH_BOOTSTRAP_PATH}?${searchParams.toString()}`;
}

export function readBackofficeOrganizationSwitchId(url: URL | string): string | null {
  const resolvedUrl = typeof url === "string" ? new URL(url, "http://localhost") : url;
  return resolvedUrl.searchParams.get(BACKOFFICE_ORGANIZATION_ID_PARAM)?.trim() || null;
}

export function retargetBackofficeOrganizationReturnTo(
  returnTo: string,
  organizationId: string | null,
): string {
  const sanitizedReturnTo = sanitizeBackofficeReturnTo(returnTo) ?? BACKOFFICE_HOME_PATH;
  if (!organizationId || !sanitizedReturnTo.startsWith(BACKOFFICE_HOME_PATH)) {
    return sanitizedReturnTo;
  }

  const destination = new URL(sanitizedReturnTo, "http://localhost");
  destination.pathname = destination.pathname.replace(
    /\/org\/[^/]+/,
    `/org/${encodeURIComponent(organizationId)}`,
  );
  return `${destination.pathname}${destination.search}`;
}

export function readBackofficeReturnTo(url: URL | string): string {
  const resolvedUrl = typeof url === "string" ? new URL(url, "http://localhost") : url;
  return (
    sanitizeBackofficeReturnTo(resolvedUrl.searchParams.get(BACKOFFICE_RETURN_TO_PARAM)) ??
    BACKOFFICE_HOME_PATH
  );
}
