import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";

import type { FilePrincipal } from "./permissions";
import type { FilesBackend, FilesContext } from "./types";

export type CreateSystemFilesContextOptions = {
  origin?: string;
  backend?: FilesBackend;
  request?: Request;
  objects?: BackofficeObjectRegistry;
  execution: BackofficeExecutionContext;
  filePrincipal?: FilePrincipal;
  automationHookQueue?: FilesContext["automationHookQueue"];
  staticFileArtifacts: FilesContext["staticFileArtifacts"];
};

/**
 * Creates a root/system filesystem context for trusted internal callers.
 *
 * This helper does not manufacture fake org-scoped objects. Object-backed contributors are only
 * available when a real BackofficeObjectRegistry is supplied, and otherwise simply do not mount.
 */
export const createSystemFilesContext = ({
  objects,
  execution,
  filePrincipal,
  ...filesContext
}: CreateSystemFilesContextOptions): FilesContext => {
  const kernel = new BackofficeKernel({ objects });

  return {
    ...filesContext,
    ...(objects ? { objects } : {}),
    execution,
    kernel,
    filePrincipal: filePrincipal ?? kernel.resolveFilePrincipal(execution),
    staticFileArtifacts: filesContext.staticFileArtifacts,
  };
};
