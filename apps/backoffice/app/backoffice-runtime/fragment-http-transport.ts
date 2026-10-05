import {
  BACKOFFICE_INTERNAL_CONTEXT_HEADER,
  BackofficeInternalRequestError,
  removeBackofficeInternalContextHeader,
  verifyAuthorizedBackofficeObjectRequest,
  type BackofficeAuthorizedRequestContext,
} from "./internal-object-request";
import type { BackofficeObjectAddress } from "./object-registry";

/** Verifies signed execution provenance; the receiving fragment's middleware owns route authorization. */
export function createBackofficeFragmentHttpTransport({
  address,
  env,
  nowEpochMs,
}: {
  address: BackofficeObjectAddress;
  env: Pick<CloudflareEnv, "BACKOFFICE_INTERNAL_REQUEST_SECRET">;
  nowEpochMs: () => number;
}) {
  return async function forwardVerifiedFragmentRequest(
    request: Request,
    forward: (
      request: Request,
      options: {
        requestContext: BackofficeAuthorizedRequestContext | undefined;
        propagationContext: Readonly<Record<string, string>> | null;
      },
    ) => Promise<Response>,
  ): Promise<Response> {
    try {
      const verified = request.headers.has(BACKOFFICE_INTERNAL_CONTEXT_HEADER)
        ? await verifyAuthorizedBackofficeObjectRequest({
            request,
            address,
            env,
            nowEpochMs: nowEpochMs(),
          })
        : null;
      return await forward(verified?.request ?? removeBackofficeInternalContextHeader(request), {
        requestContext: verified?.context,
        propagationContext: verified?.context.propagationContext ?? null,
      });
    } catch (cause) {
      if (!(cause instanceof BackofficeInternalRequestError)) {
        throw cause;
      }
      return Response.json(
        { code: "INVALID_INTERNAL_CONTEXT", message: cause.message },
        { status: 401 },
      );
    }
  };
}
