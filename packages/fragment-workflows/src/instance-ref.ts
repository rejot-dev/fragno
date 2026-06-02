import { createHash } from "node:crypto";

export function buildScopedInstanceRowId(workflowName: string, instanceId: string) {
  const digest = createHash("sha256")
    .update(workflowName)
    .update("\0")
    .update(instanceId)
    .digest("base64url");
  return `wfi_${digest}`;
}
