import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { DurableHookQueueOptions, DurableHookQueueResponse } from "@/fragno/durable-hooks";

import { createMasterFileSystem, type MasterFileSystem } from "./master-file-system";

const INTERNAL_ORIGIN = "https://files.internal";

export type CreateBackofficeFileSystemOptions = {
  objects: BackofficeObjectRegistry;
  /**
   * Override for the automations DO to call its own getHookQueue() directly
   * instead of going through an external stub (avoids deadlock during init).
   */
  automationHookQueue?: (opts?: DurableHookQueueOptions) => Promise<DurableHookQueueResponse>;
  execution: BackofficeExecutionContext;
  kernel: BackofficeKernel;
};

export const createBackofficeFileSystem = async (
  options: CreateBackofficeFileSystemOptions,
): Promise<MasterFileSystem> => {
  const filePrincipal = options.kernel.resolveFilePrincipal(options.execution);

  return createMasterFileSystem({
    origin: INTERNAL_ORIGIN,
    objects: options.objects,
    execution: options.execution,
    kernel: options.kernel,
    filePrincipal,
    ...(options.automationHookQueue ? { automationHookQueue: options.automationHookQueue } : {}),
  });
};
