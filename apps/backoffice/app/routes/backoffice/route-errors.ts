import { isRouteErrorResponse } from "react-router";

export const BACKOFFICE_ORGANIZATION_NOT_FOUND_CODE = "BACKOFFICE_ORGANIZATION_NOT_FOUND";

type RouteErrorData = {
  code?: unknown;
  message?: unknown;
  resource?: unknown;
  organizationSlug?: unknown;
  debugDetails?: unknown;
};

export type BackofficeOrganizationNotFound = {
  organizationSlug: string | null;
};

const stringifyRouteErrorValue = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, entry: unknown): unknown => (typeof entry === "bigint" ? `${entry.toString()}n` : entry),
    2,
  );

const getRouteErrorData = (error: unknown): RouteErrorData | null => {
  if (!isRouteErrorResponse(error) || !error.data || typeof error.data !== "object") {
    return null;
  }

  return error.data as RouteErrorData;
};

/** Throws the structured 404 consumed by authenticated Backoffice error boundaries. */
export function throwBackofficeOrganizationNotFound(organizationSlug?: string): never {
  const normalizedSlug = organizationSlug?.trim() || null;
  throw Response.json(
    {
      code: BACKOFFICE_ORGANIZATION_NOT_FOUND_CODE,
      resource: "organization" as const,
      organizationSlug: normalizedSlug,
      message: normalizedSlug
        ? `Organization '${normalizedSlug}' could not be found.`
        : "Organization could not be found.",
    },
    { status: 404, statusText: "Not Found" },
  );
}

/** Returns structured organization-not-found details without string matching. */
export function getBackofficeOrganizationNotFound(
  error: unknown,
): BackofficeOrganizationNotFound | null {
  const errorData = getRouteErrorData(error);
  if (errorData?.code !== BACKOFFICE_ORGANIZATION_NOT_FOUND_CODE) {
    return null;
  }
  return {
    organizationSlug:
      typeof errorData.organizationSlug === "string" && errorData.organizationSlug
        ? errorData.organizationSlug
        : null,
  };
}

export const getRouteErrorMessage = (
  error: unknown,
  fallback = "An unexpected error occurred.",
) => {
  const errorData = getRouteErrorData(error);
  if (typeof errorData?.message === "string" && errorData.message) {
    return errorData.message;
  }

  if (isRouteErrorResponse(error) && typeof error.data === "string") {
    return error.data;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
};

export const getRouteErrorDebugDetails = (error: unknown) => {
  if (error instanceof Error) {
    return [error.name, error.message, error.stack].filter(Boolean).join("\n\n");
  }

  if (isRouteErrorResponse(error)) {
    const lines = [`${error.status} ${error.statusText}`];
    const errorData = getRouteErrorData(error);
    if (typeof errorData?.debugDetails === "string" && errorData.debugDetails) {
      lines.push(errorData.debugDetails);
    } else if (error.data !== undefined) {
      lines.push(
        typeof error.data === "string"
          ? error.data
          : (stringifyRouteErrorValue(error.data) ?? String(error.data)),
      );
    }
    return lines.join("\n\n");
  }

  if (typeof error === "string") {
    return error;
  }

  return stringifyRouteErrorValue(error) ?? String(error);
};
