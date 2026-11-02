import {
  type BackofficeRoutableScope,
  isBackofficeRoutableScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { AcceptedShare } from "@fragno-dev/backoffice-api/v0/shares";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createBackofficeStaticFileCollection } from "@/files/content/static";
import { createAcceptedShares } from "@/fragno/runtime-tools/shares-runtime";

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

/** The folders among the shares `scope` accepted; blob shares are read through blobs. */
function acceptedSharedFolders({
  runtime,
  kernel,
  scope,
}: {
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
  scope: BackofficeRoutableScope;
}): SharedFolders {
  const shares = createAcceptedShares({
    scope,
    automationsFor: (owner) =>
      kernel.scoped("AUTOMATIONS", owner, runtime.objects.automations).commands,
  });
  const folder = (accepted: AcceptedShare): SharedFolder => ({
    name: accepted.name,
    async open() {
      const opened = await shares.openFolder(accepted);
      if (!opened) {
        return null;
      }
      return {
        collection: createWorkspaceFileCollection(
          kernel.scoped("UPLOAD", opened.from, runtime.objects.upload).http,
          opened.path.slice(WORKSPACE_ROOT.length),
        ),
        standing: async () => (await shares.openFolder(accepted)) !== null,
      };
    },
  });
  return {
    async list() {
      return (await shares.list()).filter(({ of }) => of.kind === "folder").map(folder);
    },
    async find(name) {
      const accepted = await shares.find(name);
      return accepted?.of.kind === "folder" ? folder(accepted) : null;
    },
  };
}
