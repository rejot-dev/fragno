import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { SYSTEM_BACKOFFICE_PRINCIPAL } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";

import type { FilePrincipal } from "./permissions";
import type { FilesBackend, FilesContext } from "./types";

export type CreateSystemFilesContextOptions = {
  origin?: string;
  backend?: FilesBackend;
  request?: Request;
  orgId?: string;
  objects?: BackofficeObjectRegistry;
  execution?: BackofficeExecutionContext;
  filePrincipal?: FilePrincipal;
  automationHookQueue?: FilesContext["automationHookQueue"];
};

/**
 * Creates a root/system filesystem context for trusted internal callers.
 *
 * This helper does not manufacture fake org-scoped objects. Object-backed contributors are only
 * available when a real BackofficeObjectRegistry is supplied, and otherwise simply do not mount.
 */
export const createSystemFilesContext = ({
  orgId,
  objects,
  execution,
  filePrincipal,
  ...filesContext
}: CreateSystemFilesContextOptions = {}): FilesContext => {
  const resolvedExecution =
    execution ??
    ({
      actor: SYSTEM_BACKOFFICE_PRINCIPAL,
      scope: orgId ? { kind: "org", orgId } : { kind: "system" },
    } satisfies BackofficeExecutionContext);
  const kernel = new BackofficeKernel({ objects });

  return {
    ...filesContext,
    ...(objects ? { objects } : {}),
    execution: resolvedExecution,
    kernel,
    filePrincipal: filePrincipal ?? kernel.resolveFilePrincipal(resolvedExecution),
  };
};
