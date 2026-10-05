/** Child-process IPC readiness discriminator; emitted only after runtime authority is serving. */
export const nodeReadyMessageKind = "demo-node-ready";

/** Identifies one bound node process after its runtime authority begins serving. */
export type NodeReadyMessage = {
  kind: typeof nodeReadyMessageKind;
  applicationOrigin: string;
  internalOrigin: string;
  peerWebSocketAddress: string;
  nodeId: string;
  processGeneration: string;
};

/** Validates the readiness message received across the child-process IPC boundary. */
export function requireNodeReadyMessage(value: unknown): NodeReadyMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("DEMO_NODE_READY_MESSAGE_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (
    record["kind"] !== nodeReadyMessageKind ||
    typeof record["applicationOrigin"] !== "string" ||
    typeof record["internalOrigin"] !== "string" ||
    typeof record["peerWebSocketAddress"] !== "string" ||
    typeof record["nodeId"] !== "string" ||
    typeof record["processGeneration"] !== "string"
  ) {
    throw new Error("DEMO_NODE_READY_MESSAGE_INVALID");
  }
  return {
    kind: nodeReadyMessageKind,
    applicationOrigin: record["applicationOrigin"],
    internalOrigin: record["internalOrigin"],
    peerWebSocketAddress: record["peerWebSocketAddress"],
    nodeId: record["nodeId"],
    processGeneration: record["processGeneration"],
  };
}
