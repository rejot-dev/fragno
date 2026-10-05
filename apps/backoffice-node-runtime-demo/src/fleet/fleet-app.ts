import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { renderFleetPage } from "./fleet-page";
import {
  FleetSupervisor,
  type FleetForwardedRequest,
  type FleetLifecycleAction,
} from "./fleet-supervisor";

/** Builds the fleet supervisor UI and its exact-node debugging API. */
export function createFleetApp(supervisor: FleetSupervisor) {
  const app = new Hono();

  app.use(
    "*",
    bodyLimit({
      maxSize: 1_048_576,
      onError() {
        throw new FleetRequestError("DEMO_FLEET_REQUEST_BODY_TOO_LARGE");
      },
    }),
  );
  app.onError((error, context) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("DEMO_FLEET_REQUEST_FAILED", error);
    const status = error instanceof FleetRequestError ? 400 : 503;
    return context.json({ error: message }, status);
  });
  app.notFound((context) => {
    return context.json({ error: "DEMO_FLEET_ROUTE_NOT_FOUND" }, 404);
  });

  app.get("/", (context) => {
    return context.html(renderFleetPage());
  });
  app.get("/health", (context) => {
    return context.json({ status: "ready" });
  });
  app.get("/api/fleet", async (context) => {
    context.header("Cache-Control", "no-store");
    return context.json(await supervisor.readFleetSnapshot());
  });
  app.post("/api/nodes/:slot/requests", async (context) => {
    const request = requireFleetForwardedRequest(await context.req.json());
    const response = await supervisor.forwardRequest(context.req.param("slot"), request);
    return context.json(response);
  });
  app.post("/api/nodes/:slot/lifecycle", async (context) => {
    const action = requireFleetLifecycleAction(await context.req.json());
    await supervisor.changeNodeLifecycle(context.req.param("slot"), action);
    return context.json({ nodeSlot: context.req.param("slot"), action, completed: true });
  });

  return app;
}

function requireFleetForwardedRequest(value: unknown): FleetForwardedRequest {
  const record = requireFleetRequestRecord(value);
  const ingress = record["ingress"];
  if (ingress !== "application" && ingress !== "internal") {
    throw new FleetRequestError("DEMO_FLEET_INGRESS_INVALID");
  }
  const method = record["method"];
  const pathname = record["path"];
  const body = record["body"];
  if (method !== "GET" && method !== "POST") {
    throw new FleetRequestError("DEMO_FLEET_METHOD_INVALID");
  }
  if (
    typeof pathname !== "string" ||
    pathname.length === 0 ||
    pathname.length > 512 ||
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    hasFleetPathControlCharacter(pathname)
  ) {
    throw new FleetRequestError("DEMO_FLEET_PATH_INVALID");
  }
  if (!("body" in record)) {
    throw new FleetRequestError("DEMO_FLEET_BODY_MISSING");
  }
  return { ingress, method, path: pathname, body };
}

function requireFleetLifecycleAction(value: unknown): FleetLifecycleAction {
  const action = requireFleetRequestRecord(value)["action"];
  if (
    action !== "stop" &&
    action !== "crash" &&
    action !== "restart" &&
    action !== "delete-cache-and-restart"
  ) {
    throw new FleetRequestError("DEMO_FLEET_LIFECYCLE_ACTION_INVALID");
  }
  return action;
}

function hasFleetPathControlCharacter(pathname: string): boolean {
  for (let index = 0; index < pathname.length; index += 1) {
    const characterCode = pathname.charCodeAt(index);
    if (characterCode < 32 || characterCode === 127) {
      return true;
    }
  }
  return false;
}

function requireFleetRequestRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FleetRequestError("DEMO_FLEET_JSON_OBJECT_REQUIRED");
  }
  return value as Record<string, unknown>;
}

class FleetRequestError extends Error {}
