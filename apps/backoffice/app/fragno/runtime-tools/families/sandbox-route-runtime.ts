import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";

import { createSandboxRuntime, type SandboxRuntime } from "./sandbox-runtime";

export const createSandboxRouteRuntime = ({
  objects,
  orgId,
}: {
  objects: BackofficeObjectRegistry;
  orgId: string;
}): SandboxRuntime => {
  const normalizedOrgId = orgId.trim();
  if (!normalizedOrgId) {
    throw new Error("Sandbox runtime requires an organization id");
  }

  return createSandboxRuntime({
    lifecycle: objects.sandboxManager.forOrg(normalizedOrgId).commands,
  });
};
