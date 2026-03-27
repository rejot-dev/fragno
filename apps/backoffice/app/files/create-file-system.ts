import type { DurableHookQueueOptions, DurableHookQueueResponse } from "@/fragno/durable-hooks";

import { automationHooksFileContributor } from "./contributors/durable-hooks";
import { createMasterFileSystem, type MasterFileSystem } from "./master-file-system";

const INTERNAL_ORIGIN = "https://files.internal";

export type CreateOrgFileSystemOptions = {
  orgId: string;
  env: Pick<CloudflareEnv, "UPLOAD" | "RESEND" | "AUTOMATIONS">;
  /**
   * Override for the automations DO to call its own getHookQueue() directly
   * instead of going through an external stub (avoids deadlock during init).
   */
  automationHookQueue?: (opts?: DurableHookQueueOptions) => Promise<DurableHookQueueResponse>;
};

export const createOrgFileSystem = async (
  options: CreateOrgFileSystemOptions,
): Promise<MasterFileSystem> => {
  const { orgId, env } = options;

  let uploadConfig = null;
  let uploadRuntime: { baseUrl: string; fetch: typeof fetch } | undefined;

  if (env.UPLOAD) {
    const uploadDo = env.UPLOAD.get(env.UPLOAD.idFromName(orgId));
    uploadConfig = await uploadDo.getAdminConfig();
    uploadRuntime = {
      baseUrl: INTERNAL_ORIGIN,
      fetch: uploadDo.fetch.bind(uploadDo),
    };
  }

  const resendDo = env.RESEND.get(env.RESEND.idFromName(orgId));
  const resendRuntime = {
    baseUrl: INTERNAL_ORIGIN,
    fetch: resendDo.fetch.bind(resendDo),
  };

  const automationsDo = options.automationHookQueue
    ? null
    : env.AUTOMATIONS.get(env.AUTOMATIONS.idFromName(orgId));

  const durableHooksRuntimes = [
    {
      contributorId: automationHooksFileContributor.id,
      getHookQueue: options.automationHookQueue
        ? (opts?: DurableHookQueueOptions) => options.automationHookQueue!(opts)
        : (opts?: DurableHookQueueOptions) =>
            automationsDo!.getHookQueue({ ...opts, fragment: "automation" as const }),
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
