import type {
  BackofficeApi,
  BackofficeApiImplementation,
  BackofficeApiStreamImplementation,
} from "@fragno-dev/backoffice-api/api";
import { createOpenApiDocument } from "@fragno-dev/backoffice-api/openapi";
import { backofficeApiV0 } from "@fragno-dev/backoffice-api/v0";
import {
  type BackofficeContextScope,
  backofficeScopeContains,
  parseBackofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { Hono } from "hono";
import { z } from "zod";

import { type BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { isBackofficeForbiddenError, type BackofficeKernel } from "@/backoffice-runtime/kernel";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  createInstalledAppExecution,
  installedAppEventSource,
} from "@/fragno/app-installations/authority";
import { appInstallationTargetScope } from "@/fragno/app-installations/contracts";
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

import { apiError } from "./api-error";
import { backofficeProvisioningRouter } from "./provisioning-router";
import { createRuntimeToolHandlers } from "./runtime-tool-handlers";
import { backofficeApiV0Adapters } from "./v0-adapters";
import { backofficeApiV0Streams, type BackofficeApiStreamContext } from "./v0-streams";

/** Per-request services; both hosts create them before dispatching here. */
type BackofficeApiBindings = { runtime: BackofficeRuntimeServices; kernel: BackofficeKernel };

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
  const target = appInstallationTargetScope(scope);
  if (!target || !backofficeScopeContains(credential.scopeRestriction, target)) {
    return {
      ok: false,
      response: apiError("forbidden", "The credential does not permit this scope."),
    };
  }
  return {
    ok: true,
    execution: createInstalledAppExecution({
      scope: target,
      actor: credential.actor,
      installation: credential.installation,
    }),
    emittedEventSource: installedAppEventSource(credential.installation.appId),
  };
}

/** A handler's failure as an API error. */
function failedOperationResponse(error: unknown): Response {
  // Kernel denials can cross object RPC, which keeps their name but not their class.
  if (isBackofficeForbiddenError(error)) {
    return apiError("forbidden", error.message);
  }
  if (error instanceof BackofficeOperationError) {
    return apiError(error.kind, error.message);
  }
  // Untyped failures still carry user-facing messages, as in Bash and Codemode.
  return apiError(
    "operation_failed",
    error instanceof Error ? error.message : "The operation failed.",
  );
}

function createVersionRouter<TApi extends BackofficeApi>(
  api: TApi,
  handlers: BackofficeApiImplementation<TApi, BackofficeToolContext>,
  streamHandlers: BackofficeApiStreamImplementation<TApi, BackofficeApiStreamContext>,
) {
  // Both share one path, so an id that is both would make the operation unreachable.
  const ambiguous = Object.keys(api.streams).filter((id) => Object.hasOwn(api.operations, id));
  if (ambiguous.length > 0) {
    throw new Error(
      `API ${api.version} ids are both operations and streams: ${ambiguous.join(", ")}.`,
    );
  }
  const router = new Hono<{ Bindings: BackofficeApiBindings }>();

  router.get("/openapi.json", (c) =>
    c.json(createOpenApiDocument(api, { serverUrl: new URL(c.req.url).origin })),
  );

  router.post("/scopes/:scope/:operationId", async (c) => {
    const operationId = c.req.param("operationId");
    const isStream = Object.hasOwn(api.streams, operationId);
    if (!isStream && !Object.hasOwn(api.operations, operationId)) {
      return apiError("not_found", `Unknown operation '${operationId}'.`);
    }
    const { input: inputSchema } = isStream
      ? api.streams[operationId]
      : api.operations[operationId];

    let scope: BackofficeContextScope;
    try {
      // Hono decodes path parameters, but scope ids are URI-encoded inside the segment.
      scope = parseBackofficeScopePathSegment(c.req.path.split("/").at(-2) ?? "");
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
    if (inputSchema.def.type !== "void") {
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = inputSchema.safeParse(body);
      if (!parsed.success) {
        return apiError(
          "invalid_request",
          body === undefined ? "The body must be JSON." : z.prettifyError(parsed.error),
        );
      }
      input = parsed.data;
    }

    if (isStream) {
      // The handler was matched to this stream, and `input` was parsed by its schema.
      const handleStream = streamHandlers[operationId] as (
        input: unknown,
        context: BackofficeApiStreamContext,
      ) => Promise<ReadableStream<Uint8Array>>;
      let frames: ReadableStream<Uint8Array>;
      try {
        frames = await handleStream(input, {
          runtime,
          kernel,
          execution: authorization.execution,
          signal: c.req.raw.signal,
        });
      } catch (error) {
        return failedOperationResponse(error);
      }
      return new Response(frames, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    const operation = api.operations[operationId];
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
            emitter: { kind: "caller" },
            runtime,
            kernel,
            execution: authorization.execution,
            billingOrganizationId: null,
            emittedEventSource: authorization.emittedEventSource,
          }),
        ),
      );
    } catch (error) {
      return failedOperationResponse(error);
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
  .route(`/api/${backofficeApiV0.version}/provisioning`, backofficeProvisioningRouter)
  .route(
    `/api/${backofficeApiV0.version}`,
    createVersionRouter(
      backofficeApiV0,
      createRuntimeToolHandlers(backofficeApiV0, backofficeApiV0Adapters),
      backofficeApiV0Streams,
    ),
  )
  .notFound(() => apiError("not_found", "Not found."));

export function isBackofficeApiPath(pathname: string): boolean {
  return /^\/api\/v\d+(?:\/|$)/u.test(pathname);
}
