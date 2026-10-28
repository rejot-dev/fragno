import {
  type BackofficeRoutableScope,
  backofficeContextScopesEqual,
  isBackofficeRoutableScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { AcceptedFileShare } from "@fragno-dev/backoffice-api/v0/state";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createBackofficeStaticFileCollection } from "@/files/content/static";

import {
  createBackofficeStateBackend,
  createBackofficeSystemStateBackend,
  createWorkspaceFileCollection,
  type BackofficeStateBackend,
  type SharedFolder,
  type SharedFolders,
} from "./state-backend";

const WORKSPACE_ROOT = "/workspace/";

/** Selects shared state storage and reference collections for an established execution scope. */
export function createRuntimeStateBackend({
  runtime,
  kernel,
  execution,
}: {
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
}): BackofficeStateBackend {
  const staticFileCollection = createBackofficeStaticFileCollection();
  if (execution.scope.kind === "system") {
    return createBackofficeSystemStateBackend({ staticFileCollection });
  }
  if (!runtime.config.bindings.upload || !isBackofficeRoutableScope(execution.scope)) {
    throw new Error("Scoped state requires Upload-backed storage.");
  }
  return createBackofficeStateBackend({
    uploadObject: kernel.scoped("UPLOAD", execution.scope, runtime.objects.upload).http,
    staticFileCollection,
    sharedFolders: acceptedSharedFolders({ runtime, kernel, scope: execution.scope }),
  });
}

/**
 * The shares `scope` accepted. The sharing scope's share is the authority: this scope reads the
 * folder through it only while it stands and names this scope, whatever this scope's own record
 * says, and asks again on every use, so revoking takes effect at once.
 */
function acceptedSharedFolders({
  runtime,
  kernel,
  scope,
}: {
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
  scope: BackofficeRoutableScope;
}): SharedFolders {
  const automations = (owner: BackofficeRoutableScope) =>
    kernel.scoped("AUTOMATIONS", owner, runtime.objects.automations).commands;
  // The share, while it stands and names this scope.
  const standingShare = async (accepted: AcceptedFileShare) => {
    const share = await automations(accepted.from).getFileShare({ shareId: accepted.shareId });
    return share && backofficeContextScopesEqual(share.with, scope) ? share : null;
  };
  const folder = (accepted: AcceptedFileShare): SharedFolder => ({
    name: accepted.name,
    async open() {
      const share = await standingShare(accepted);
      if (!share) {
        return null;
      }
      return {
        collection: createWorkspaceFileCollection(
          kernel.scoped("UPLOAD", accepted.from, runtime.objects.upload).http,
          share.path.slice(WORKSPACE_ROOT.length),
        ),
        standing: async () => (await standingShare(accepted)) !== null,
      };
    },
  });
  return {
    async list() {
      return (await automations(scope).listAcceptedFileShares()).map(folder);
    },
    async find(name) {
      const accepted = await automations(scope).getAcceptedFileShareByName({ name });
      return accepted ? folder(accepted) : null;
    },
  };
}
