import { isBackofficeRoutableScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createBackofficeStaticFileCollection } from "@/files/content/static";

import {
  createBackofficeStateBackend,
  createBackofficeSystemStateBackend,
  type BackofficeStateBackend,
} from "./state-backend";
import { createCodemodeStaticArtifactsResolver } from "./static-codemode-artifacts";

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
  const staticFileCollection = createBackofficeStaticFileCollection(
    createCodemodeStaticArtifactsResolver({
      objects: runtime.objects,
      config: runtime.config,
      execution,
    }),
  );
  if (execution.scope.kind === "system") {
    return createBackofficeSystemStateBackend({ staticFileCollection });
  }
  if (!runtime.config.bindings.upload || !isBackofficeRoutableScope(execution.scope)) {
    throw new Error("Scoped state requires Upload-backed storage.");
  }
  return createBackofficeStateBackend({
    uploadObject: kernel.scoped("UPLOAD", execution.scope, runtime.objects.upload).http,
    staticFileCollection,
  });
}
