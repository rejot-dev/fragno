import { authenticateCodemodeHttpRequest } from "@fragno-dev/codemode/transport/codemode-http-authentication";
import type { Context, Hono } from "hono";
import { z } from "zod";

import {
  SANDBOX_IMAGES,
  SANDBOX_INSTANCE_TYPES,
  type SandboxContainerControl,
} from "../sandbox/sandbox-container-contract";
import type { SandboxBridgeHonoEnv } from "./sandbox-bridge-http-env";

const startRequestSchema = z.strictObject({
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("image"), image: z.enum(SANDBOX_IMAGES) }),
    z.strictObject({ kind: z.literal("snapshot"), snapshotId: z.string().min(1) }),
  ]),
  instanceType: z.enum(SANDBOX_INSTANCE_TYPES),
  leaseExpiresAt: z.number().int().positive().nullable(),
});

const execRequestSchema = z.strictObject({
  argv: z.array(z.string()).min(1),
  timeoutMs: z.number().int().positive(),
});

/** Bridge errors use `{ code, error }`; authentication errors keep the codemode response shape. */
function sandboxBridgeErrorResponse(status: 400 | 502, code: string, error: string): Response {
  return Response.json({ code, error }, { status });
}

async function readJsonBody<T>(
  context: Context<SandboxBridgeHonoEnv>,
  schema: z.ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return {
      ok: false,
      response: sandboxBridgeErrorResponse(400, "invalid_request", "Invalid JSON body."),
    };
  }
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        response: sandboxBridgeErrorResponse(400, "invalid_request", z.prettifyError(parsed.error)),
      };
}

/** Authenticates the caller and validates the sandbox ID before any route reaches the Durable Object. */
async function handleSandboxRequest(
  context: Context<SandboxBridgeHonoEnv>,
  handle: (sandbox: SandboxContainerControl) => Promise<Response>,
): Promise<Response> {
  const authenticationError = await authenticateCodemodeHttpRequest(
    context.req.raw,
    context.env.SANDBOX_API_KEY,
  );
  if (authenticationError) {
    return authenticationError;
  }
  const sandboxId = context.req.param("id") ?? "";
  // Physical sandbox IDs are manager-scoped base32 digests.
  if (!/^[a-z2-7]{1,128}$/.test(sandboxId)) {
    return sandboxBridgeErrorResponse(400, "invalid_request", "Invalid sandbox ID format.");
  }
  try {
    return await handle(context.env.Sandbox.getByName(sandboxId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sandboxBridgeErrorResponse(502, "sandbox_error", message);
  }
}

/** Registers the authenticated HTTP API that Node Backoffice uses to control bridge sandboxes. */
export function registerSandboxHttpRoutes(app: Hono<SandboxBridgeHonoEnv>): void {
  app.post("/v1/sandbox/:id/start", (context) =>
    handleSandboxRequest(context, async (sandbox) => {
      const request = await readJsonBody(context, startRequestSchema);
      if (!request.ok) {
        return request.response;
      }
      return Response.json(await sandbox.start(request.value));
    }),
  );

  app.post("/v1/sandbox/:id/exec", (context) =>
    handleSandboxRequest(context, async (sandbox) => {
      const request = await readJsonBody(context, execRequestSchema);
      return request.ok ? Response.json(await sandbox.exec(request.value)) : request.response;
    }),
  );

  app.post("/v1/sandbox/:id/snapshot", (context) =>
    handleSandboxRequest(context, async (sandbox) => Response.json(await sandbox.snapshot())),
  );

  app.delete("/v1/sandbox/:id", (context) =>
    handleSandboxRequest(context, async (sandbox) => {
      await sandbox.stop();
      return new Response(null, { status: 204 });
    }),
  );
}
