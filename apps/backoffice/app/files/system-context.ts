import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";

import type { FilesContext } from "./types";

/**
 * Creates a root/system filesystem context for trusted internal callers.
 *
 * This is not a request-user helper. Production setup/seed/catalog paths use it when they
 * intentionally need system ownership, and tests use it for explicit root fixtures.
 */
export const createSystemFilesContext = (
  context: Omit<FilesContext, "execution" | "kernel" | "filePrincipal"> & {
    orgId?: string;
    objects?: BackofficeObjectRegistry;
    execution?: BackofficeExecutionContext;
    filePrincipal?: FilesContext["filePrincipal"];
  },
): FilesContext => {
  const objects = context.objects ?? ({} as BackofficeObjectRegistry);
  const { orgId, objects: _objects, execution, filePrincipal, ...filesContext } = context;
  const resolvedExecution =
    execution ??
    ({
      actor: { type: "system", id: "files-system" },
      scope: { kind: "org", orgId: orgId ?? "system-files" },
    } satisfies BackofficeExecutionContext);
  const kernel = new BackofficeKernel({ objects });

  return {
    ...filesContext,
    execution: resolvedExecution,
    kernel,
    filePrincipal: filePrincipal ?? kernel.resolveFilePrincipal(resolvedExecution),
  };
};
