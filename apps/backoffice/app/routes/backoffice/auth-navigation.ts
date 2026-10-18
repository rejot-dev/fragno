export const BACKOFFICE_HOME_PATH = "/backoffice";
export const BACKOFFICE_LOGIN_PATH = "/backoffice/login";
export const BACKOFFICE_SIGN_UP_PATH = "/backoffice/sign-up";

export function backofficeInvitationPath(invitationId: string): string {
  return `/backoffice/invitations/${encodeURIComponent(invitationId)}`;
}
const BACKOFFICE_RETURN_TO_PARAM = "returnTo";

function isBackofficePath(pathname: string): boolean {
  return pathname === BACKOFFICE_HOME_PATH || pathname.startsWith(`${BACKOFFICE_HOME_PATH}/`);
}

function isAllowedBackofficeReturnToPath(pathname: string): boolean {
  return isBackofficePath(pathname);
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

export function readBackofficeReturnTo(url: URL | string): string {
  const resolvedUrl = typeof url === "string" ? new URL(url, "http://localhost") : url;
  return (
    sanitizeBackofficeReturnTo(resolvedUrl.searchParams.get(BACKOFFICE_RETURN_TO_PARAM)) ??
    BACKOFFICE_HOME_PATH
  );
}
