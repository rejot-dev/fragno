import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import { isBackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import { createStaticFileCollection } from "@/file-collection/create-static-file-collection";
import { createBackofficeStaticFileCollection } from "@/files/content/static";
import {
  createBackofficeStateBackend,
  createBackofficeSystemStateBackend,
} from "@/fragno/codemode/state-backend";
import { createCodemodeStaticArtifactsResolver } from "@/fragno/codemode/static-codemode-artifacts";

export async function readBackofficeAutomationSource({
  objects,
  kernel,
  execution,
  config,
  path,
}: {
  objects: BackofficeObjectRegistry;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  config: BackofficeRuntimeConfig;
  path: string;
}): Promise<string> {
  const staticFileCollection = createBackofficeStaticFileCollection(
    createCodemodeStaticArtifactsResolver({ objects, config, execution }),
  );

  if (execution.scope.kind === "system") {
    return await createBackofficeSystemStateBackend({ staticFileCollection }).readFile(path);
  }
  if (!config.bindings.upload || !isBackofficeRoutableScope(execution.scope)) {
    return await createBackofficeSystemStateBackend({
      staticFileCollection,
      systemFileCollection: createStaticFileCollection({}),
    }).readFile(path);
  }

  return await createBackofficeStateBackend({
    uploadObject: kernel.scoped("UPLOAD", execution.scope, objects.upload).http,
    staticFileCollection,
  }).readFile(path);
}
