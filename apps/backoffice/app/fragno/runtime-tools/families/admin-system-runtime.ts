import type { BackofficeToolContext } from "../runtime-tools";
import type { AdminRuntime } from "./admin";

export type AdminSystemToolContext = BackofficeToolContext<Partial<{ admin: AdminRuntime }>>;

/** System-wide administration acts only in System context, where the admin runtime lives. */
export function requireSystemAdminRuntime(
  context: AdminSystemToolContext,
  management: string,
): AdminRuntime {
  if (context.execution.scope.kind !== "system") {
    throw new Error(`Admin ${management} requires System context.`);
  }
  const admin = context.runtimes.admin;
  if (!admin) {
    throw new Error(`Admin ${management} runtime is not available in this execution context.`);
  }
  return admin;
}
