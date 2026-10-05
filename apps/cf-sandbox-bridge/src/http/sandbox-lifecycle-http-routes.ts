import { hasExpectedBearerAuthorization } from "@fragno-dev/codemode/transport/codemode-http-authentication";
import type { Context, Hono } from "hono";

import type { SandboxBridgeHonoEnv } from "./sandbox-bridge-http-env";

type SandboxLifecycleConfiguration = {
  keepAlive?: boolean;
  sleepAfter?: string | number;
};

function sandboxBridgeErrorResponse(
  status: 400 | 401 | 502 | 503,
  code: string,
  error: string,
): Response {
  return Response.json({ code, error }, { status });
}

async function authenticateSandboxLifecycleRequest(
  context: Context<SandboxBridgeHonoEnv>,
): Promise<Response | null> {
  const apiKey = context.env.SANDBOX_API_KEY;
  if (!apiKey) {
    return sandboxBridgeErrorResponse(
      503,
      "authentication_not_configured",
      "Sandbox bridge authentication is not configured.",
    );
  }
  return (await hasExpectedBearerAuthorization(context.req.raw, apiKey))
    ? null
    : sandboxBridgeErrorResponse(401, "unauthorized", "Unauthorized");
}

function parseSandboxLifecycleConfiguration(value: unknown): SandboxLifecycleConfiguration | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "keepAlive" && key !== "sleepAfter")) {
    return null;
  }
  const hasKeepAlive = Object.hasOwn(record, "keepAlive");
  const hasSleepAfter = Object.hasOwn(record, "sleepAfter");
  if (!hasKeepAlive && !hasSleepAfter) {
    return null;
  }
  if (hasKeepAlive && typeof record["keepAlive"] !== "boolean") {
    return null;
  }
  if (hasSleepAfter && !isSandboxSleepAfterValue(record["sleepAfter"])) {
    return null;
  }
  return {
    ...(hasKeepAlive ? { keepAlive: record["keepAlive"] as boolean } : {}),
    ...(hasSleepAfter ? { sleepAfter: record["sleepAfter"] as string | number } : {}),
  };
}

function isSandboxSleepAfterValue(value: unknown): value is string | number {
  if (typeof value === "number") {
    return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
  }
  return typeof value === "string" && /^\d+[smh]$/i.test(value);
}

async function configureSandboxLifecycle(
  context: Context<SandboxBridgeHonoEnv>,
): Promise<Response> {
  const authenticationError = await authenticateSandboxLifecycleRequest(context);
  if (authenticationError) {
    return authenticationError;
  }

  const sandboxId = context.req.param("id");
  if (!sandboxId || !/^[a-z2-7]{1,128}$/.test(sandboxId)) {
    return sandboxBridgeErrorResponse(400, "invalid_request", "Invalid sandbox ID format");
  }

  let value: unknown;
  try {
    value = await context.req.json();
  } catch {
    return sandboxBridgeErrorResponse(400, "invalid_request", "Invalid JSON body");
  }
  const configuration = parseSandboxLifecycleConfiguration(value);
  if (!configuration) {
    return sandboxBridgeErrorResponse(
      400,
      "invalid_request",
      "Lifecycle configuration requires keepAlive or sleepAfter with valid values.",
    );
  }

  const poolId = context.env.WarmPool.idFromName("global-pool");
  const pool = context.env.WarmPool.get(poolId);
  try {
    await pool.configure({
      warmTarget: Number.parseInt(context.env.WARM_POOL_TARGET || "0", 10) || 0,
      refreshInterval:
        Number.parseInt(context.env.WARM_POOL_REFRESH_INTERVAL || "10000", 10) || 10_000,
    });
    const containerId = await pool.getContainer(sandboxId);
    if (!containerId) {
      throw new Error("Sandbox warm pool did not return a container ID.");
    }
    const sandbox = context.env.Sandbox.get(context.env.Sandbox.idFromName(containerId));
    await sandbox.configure(configuration);
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("instance limit reached")) {
      return sandboxBridgeErrorResponse(503, "capacity_exceeded", message);
    }
    return sandboxBridgeErrorResponse(
      502,
      "pool_error",
      `Lifecycle configuration failed: ${message}`,
    );
  }
}

/** Registers the authenticated Sandbox SDK lifecycle configuration route. */
export function registerSandboxLifecycleHttpRoutes(app: Hono<SandboxBridgeHonoEnv>): void {
  app.put("/v1/sandbox/:id/configuration", configureSandboxLifecycle);
}
