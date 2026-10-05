import { demoObjectNamePattern } from "../objects/demo-object-definition";

/** Invalid demo HTTP input, distinguished from authority and execution failures. */
export class NodeRequestInputError extends Error {}

/** Validates an object name at the application or internal HTTP boundary. */
export function requireDemoObjectName(value: string | undefined): string {
  if (!value || !demoObjectNamePattern.test(value)) {
    throw new NodeRequestInputError("DEMO_OBJECT_NAME_INVALID");
  }
  return value;
}

/** Maps application or post-handler durability failures to the demo's HTTP error response. */
export function handleNodeFetchFailure(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  console.error("DEMO_REQUEST_FAILED", error);
  const status =
    error instanceof NodeRequestInputError
      ? 400
      : message.includes("NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED") ||
          message.includes("NODE_OBJECT_RUNTIME_ROUTE_") ||
          message.includes("NODE_PEER_RPC_")
        ? 503
        : 500;
  return Response.json({ error: message }, { status });
}
