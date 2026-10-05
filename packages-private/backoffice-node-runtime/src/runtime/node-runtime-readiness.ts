/** Reserved runtime endpoint; application handlers never receive readiness probes. */
export const nodeRuntimeReadinessPath = "/_runtime/ready";

/** Ready responses bind a serving host to the exact process incarnation in its durable lease. */
export type NodeRuntimeReadiness =
  | { status: "ready"; nodeId: string; processGeneration: string }
  | { status: "not-ready" };
