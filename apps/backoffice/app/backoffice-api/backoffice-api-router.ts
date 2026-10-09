import type { BackofficeApi, BackofficeApiImplementation } from "@fragno-dev/backoffice-api/api";
import {
  BACKOFFICE_API_ERROR_STATUS,
  type BackofficeApiError,
  type BackofficeApiErrorCode,
} from "@fragno-dev/backoffice-api/errors";
import { createOpenApiDocument } from "@fragno-dev/backoffice-api/openapi";
import { backofficeApiV0 } from "@fragno-dev/backoffice-api/v0";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { Hono } from "hono";
import { z } from "zod";

import {
  backofficeScopeContains,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { isBackofficeForbiddenError, type BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { backofficeContextScopeFromSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import {
  createInstalledAppExecution,
  installedAppEventSource,
} from "@/fragno/app-installations/authority";
import { createBackofficeExecutionForPrincipal } from "@/fragno/auth/backoffice-principal.server";
import {
  BACKOFFICE_AUTH_ERROR_HEADER,
  BACKOFFICE_TOKEN_EXPIRED_CODE,
} from "@/fragno/auth/contracts";
import {
  ACCESS_TOKEN_AUDIENCE,
  verifyBackofficeApiCredential,
} from "@/fragno/auth/token-lifecycle";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import type { BackofficeToolContext } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { principalFromBackofficeJwt } from "@/worker-runtime/request-state.server";

import {
  BackofficeApiOperationUnavailableError,
  createRuntimeToolHandlers,
} from "./runtime-tool-handlers";
import { backofficeApiV0Adapters } from "./v0-adapters";

/** Per-request services; both hosts create them before dispatching here. */
type BackofficeApiBindings = { runtime: BackofficeRuntimeServices; kernel: BackofficeKernel };

function apiError(
  code: BackofficeApiErrorCode,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json({ error: { code, message } } satisfies BackofficeApiError, {
    status: BACKOFFICE_API_ERROR_STATUS[code],
    headers: { "cache-control": "no-store", ...headers },
  });
}

/**
 * Turns a bearer credential into an execution for the requested scope. User credentials act with
 * the user's live permissions; installed-app credentials act through the installation, whose
 * activation, grants, and approved resources the kernel checks live on every operation, and emit
 * events only under the app's own source.
 */
async function authorizeApiRequest(
  request: Request,
  scope: BackofficeContextScope,
  runtime: BackofficeRuntimeServices,
): Promise<
  | {
      ok: true;
      execution: BackofficeExecutionContext;
      emittedEventSource: string | undefined;
    }
  | { ok: false; response: Response }
> {
  const authorization = request.headers.get("authorization");
  const bearer = authorization ? /^Bearer\s+([^\s]+)$/iu.exec(authorization.trim()) : null;
  if (!bearer?.[1]) {
    return {
      ok: false,
      response: apiError("authentication_failed", "A bearer credential is required."),
    };
  }
  const verification = await verifyBackofficeApiCredential(
    bearer[1],
    request.url,
    runtime.objects.auth.singleton().http,
  );
  if (!verification.ok) {
    return {
      ok: false,
      response:
        verification.reason === "expired"
          ? apiError("authentication_failed", "The credential has expired.", {
              [BACKOFFICE_AUTH_ERROR_HEADER]: BACKOFFICE_TOKEN_EXPIRED_CODE,
            })
          : apiError("authentication_failed", "The credential is invalid."),
    };
  }

  const credential = verification.payload;
  if (credential.aud === ACCESS_TOKEN_AUDIENCE) {
    try {
      return {
        ok: true,
        execution: createBackofficeExecutionForPrincipal(
          principalFromBackofficeJwt(credential, "bearer"),
          scope,
        ),
        emittedEventSource: undefined,
      };
    } catch (error) {
      if (isBackofficeForbiddenError(error)) {
        return { ok: false, response: apiError("forbidden", error.message) };
      }
      throw error;
    }
  }
  if (
    (scope.kind !== "org" && scope.kind !== "project") ||
    !backofficeScopeContains(credential.scopeRestriction, scope)
  ) {
    return {
      ok: false,
      response: apiError("forbidden", "The credential does not permit this scope."),
    };
  }
  return {
    ok: true,
    execution: createInstalledAppExecution({
      scope,
      actor: credential.actor,
      installation: credential.installation,
    }),
    emittedEventSource: installedAppEventSource(credential.installation.appId),
  };
}

function createVersionRouter<TApi extends BackofficeApi>(
  api: TApi,
  handlers: BackofficeApiImplementation<TApi, BackofficeToolContext>,
) {
  const router = new Hono<{ Bindings: BackofficeApiBindings }>();

  router.get("/openapi.json", (c) =>
    c.json(createOpenApiDocument(api, { serverUrl: new URL(c.req.url).origin })),
  );

  router.post("/scopes/:scope/:operationId", async (c) => {
    const operationId = c.req.param("operationId");
    if (!Object.hasOwn(api.operations, operationId)) {
      return apiError("not_found", `Unknown operation '${operationId}'.`);
    }
    const operation = api.operations[operationId];

    let scope: BackofficeContextScope;
    try {
      // Hono decodes path parameters, but scope ids are URI-encoded inside the segment.
      scope = backofficeContextScopeFromSinglePathSegment(c.req.path.split("/").at(-2) ?? "");
    } catch (error) {
      return apiError(
        "invalid_request",
        error instanceof Error ? error.message : "The scope is invalid.",
      );
    }
    const { runtime, kernel } = c.env;
    const authorization = await authorizeApiRequest(c.req.raw, scope, runtime);
    if (!authorization.ok) {
      return authorization.response;
    }

    let input: unknown;
    if (operation.input.def.type !== "void") {
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = operation.input.safeParse(body);
      if (!parsed.success) {
        return apiError(
          "invalid_request",
          body === undefined ? "The body must be JSON." : z.prettifyError(parsed.error),
        );
      }
      input = parsed.data;
    }

    // The handler was matched to this operation, and `input` was parsed by its schema.
    const handle = handlers[operationId] as (
      input: unknown,
      context: BackofficeToolContext,
    ) => Promise<unknown>;
    let output: unknown;
    try {
      output = await handle(
        input,
        createBackofficeToolContext(
          createRouteBackedRuntimeContext({
            runtime,
            kernel,
            execution: authorization.execution,
            billingOrganizationId: null,
            emittedEventSource: authorization.emittedEventSource,
          }),
        ),
      );
    } catch (error) {
      if (error instanceof BackofficeApiOperationUnavailableError) {
        return apiError("not_found", error.message);
      }
      if (isBackofficeForbiddenError(error)) {
        return apiError("forbidden", error.message);
      }
      // Tools report domain failures as errors with user-facing messages, as in Bash and Codemode.
      return apiError(
        "operation_failed",
        error instanceof Error ? error.message : "The operation failed.",
      );
    }
    // Output that breaks the contract is a server bug, not a caller error.
    const response = operation.output.parse(output);
    return operation.output.def.type === "void"
      ? c.body(null, 204, { "cache-control": "no-store" })
      : c.json(response, 200, { "cache-control": "no-store" });
  });

  return router;
}

/** Serves `/api/<version>/…`; every other path belongs to React Router. */
export const backofficeApiRouter = new Hono<{ Bindings: BackofficeApiBindings }>()
  .route(
    `/api/${backofficeApiV0.version}`,
    createVersionRouter(
      backofficeApiV0,
      createRuntimeToolHandlers(backofficeApiV0, backofficeApiV0Adapters),
    ),
  )
  .notFound(() => apiError("not_found", "Not found."));

export function isBackofficeApiPath(pathname: string): boolean {
  return /^\/api\/v\d+(?:\/|$)/u.test(pathname);
}
