import type { DatabaseServiceContext } from "@fragno-dev/db";

import type { BillingEventInput } from "@/fragno/billing/contracts";

import type { PiManagerHooks } from "./pi-agent-queue";
import { piAgentDirectorySchema } from "./pi-manager-schema";

/** Model usage that `deliverModelUsage` records on the ledger of its scope's root owner. */
export type PiModelUsage = {
  event: BillingEventInput;
};

export function piModelUsageServices(
  defineService: <TService>(
    service: TService & ThisType<DatabaseServiceContext<PiManagerHooks>>,
  ) => TService,
) {
  return defineService({
    /** Commits usage the provider already charged, so a billing outage only delays its delivery. */
    recordModelUsage: function (usage: PiModelUsage) {
      return this.serviceTx(piAgentDirectorySchema)
        .mutate(({ uow }) => {
          uow.triggerHook("deliverModelUsage", usage);
        })
        .build();
    },
  });
}
