import { isRouteErrorResponse } from "react-router";

const ORG_NOT_FOUND_CODE = "ORG_NOT_FOUND";

type RouteErrorData = {
  code?: unknown;
  message?: unknown;
  resource?: unknown;
};

const getRouteErrorData = (error: unknown): RouteErrorData | null => {
  if (!isRouteErrorResponse(error) || !error.data || typeof error.data !== "object") {
    return null;
  }

  return error.data as RouteErrorData;
};

export function throwOrganisationNotFound(orgId?: string): never {
  throw Response.json(
    {
      code: ORG_NOT_FOUND_CODE,
      resource: "organisation" as const,
      message: orgId
        ? `Organisation '${orgId}' could not be found.`
        : "Organisation could not be found.",
    },
    { status: 404, statusText: "Not Found" },
  );
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

export const isOrganisationNotFoundError = (error: unknown) => {
  const errorData = getRouteErrorData(error);
  return errorData?.code === ORG_NOT_FOUND_CODE || errorData?.resource === "organisation";
};
