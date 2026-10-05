import type { BackofficeAuthorizedRequestContext } from "./internal-object-request";
import { type BackofficeKernel, isBackofficeForbiddenError } from "./kernel";
import {
  BACKOFFICE_REQUIRED_PERMISSION_HEADER,
  type BackofficePermissionRequirement,
} from "./permissions";

/** Null means no middleware rule matched: newly added fragment routes stay private by default. */
export type BackofficeFragmentHttpAccess =
  | BackofficePermissionRequirement
  | "public-ingress"
  | null;

/** Applies the kernel policy selected by typed fragment middleware, preserving HTTP denial details. */
export async function authorizeBackofficeFragmentRequest(
  kernel: BackofficeKernel,
  requestContext: unknown,
  access: BackofficeFragmentHttpAccess,
  resource: unknown,
): Promise<Response | undefined> {
  if (access === null) {
    return Response.json(
      { code: "FRAGMENT_ROUTE_NOT_EXPOSED", message: "This fragment route is not exposed." },
      { status: 404 },
    );
  }
  if (access === "public-ingress") {
    return undefined;
  }
  // Only the receiving transport supplies this context, after verifying its target-bound signature.
  const context = requestContext as BackofficeAuthorizedRequestContext | undefined;
  if (!context) {
    return Response.json(
      {
        code: "AUTHENTICATION_REQUIRED",
        message: "Fragment management requires authenticated execution.",
      },
      { status: 401 },
    );
  }
  try {
    await kernel.assertAuthorized({ execution: context.execution, operation: access, resource });
  } catch (cause) {
    if (!isBackofficeForbiddenError(cause)) {
      throw cause;
    }
    return Response.json(
      { code: cause.reason, message: cause.message },
      {
        status: cause.reason === "authority-unavailable" ? 503 : 403,
        headers: { [BACKOFFICE_REQUIRED_PERMISSION_HEADER]: JSON.stringify(access) },
      },
    );
  }
  return undefined;
}
