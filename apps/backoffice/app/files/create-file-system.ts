import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { DurableHookQueueOptions, DurableHookQueueResponse } from "@/fragno/durable-hooks";

import { automationHooksFileContributor } from "./contributors/durable-hooks";
import { createMasterFileSystem, type MasterFileSystem } from "./master-file-system";

const INTERNAL_ORIGIN = "https://files.internal";

export type CreateOrgFileSystemOptions = {
  orgId: string;
  objects: BackofficeObjectRegistry;
  /**
   * Override for the automations DO to call its own getHookQueue() directly
   * instead of going through an external stub (avoids deadlock during init).
   */
  automationHookQueue?: (opts?: DurableHookQueueOptions) => Promise<DurableHookQueueResponse>;
};

export const createOrgFileSystem = async (
  options: CreateOrgFileSystemOptions,
): Promise<MasterFileSystem> => {
  const { orgId, objects } = options;

  let uploadConfig = null;
  let uploadRuntime: { baseUrl: string; fetch: typeof fetch } | undefined;

  const uploadDo = objects.upload.forOrg(orgId);
  uploadConfig = await uploadDo.getAdminConfig();
  uploadRuntime = {
    baseUrl: INTERNAL_ORIGIN,
    fetch: async (input) => uploadDo.fetch(input instanceof Request ? input : new Request(input)),
  };

  const resendDo = objects.resend.forOrg(orgId);
  const resendRuntime = {
    baseUrl: INTERNAL_ORIGIN,
    fetch: async (input: RequestInfo | URL) =>
      resendDo.fetch(input instanceof Request ? input : new Request(input)),
  };

  const automationsDo = options.automationHookQueue ? null : objects.automations.forOrg(orgId);

  const durableHooksRuntimes = [
    {
      contributorId: automationHooksFileContributor.id,
      getHookQueue: options.automationHookQueue
        ? (opts?: DurableHookQueueOptions) => options.automationHookQueue!(opts)
        : async (opts?: DurableHookQueueOptions) => {
            const repository = await automationsDo!.getDurableHookRepository("automation");
            return await repository.getHookQueue(opts);
          },
    },
  ];

  return createMasterFileSystem({
    orgId,
    origin: INTERNAL_ORIGIN,
    uploadConfig,
    uploadRuntime,
    resendRuntime,
    durableHooksRuntimes,
  });
};
