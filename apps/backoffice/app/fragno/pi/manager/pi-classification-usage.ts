import type { DatabaseServiceContext } from "@fragno-dev/db";

import type { BillingEventInput } from "@/fragno/billing/contracts";

import type { PiManagerHooks } from "./pi-agent-queue";
import { piAgentDirectorySchema } from "./pi-manager-schema";

/** Classification usage that `deliverClassificationUsage` bills to the paying organization. */
export type PiClassificationUsage = {
  organizationId: string;
  event: BillingEventInput;
};

export function piClassificationUsageServices(
  defineService: <TService>(
    service: TService & ThisType<DatabaseServiceContext<PiManagerHooks>>,
  ) => TService,
) {
  return defineService({
    /** Commits usage the provider already charged, so a billing outage only delays its delivery. */
    recordClassificationUsage: function (usage: PiClassificationUsage) {
      return this.serviceTx(piAgentDirectorySchema)
        .mutate(({ uow }) => {
          uow.triggerHook("deliverClassificationUsage", usage);
        })
        .build();
    },
  });
}
