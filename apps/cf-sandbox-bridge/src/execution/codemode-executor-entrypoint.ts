import type {
  CodemodeExecutionCapability,
  CodemodeCapabilities,
} from "@fragno-dev/codemode/execution/codemode-activation-contract";
import { createCodemodeBridgeExecution } from "@fragno-dev/codemode/remote/codemode-bridge-execution";
import { WorkerEntrypoint } from "cloudflare:workers";

import { bridgeCodemodeActivationServices } from "./codemode-activation-services";

/**
 * Service-binding entrypoint that runs one activation per call. Each call is its own request, so
 * its guest does not count against a caller's Durable Object limit on Dynamic Workers.
 */
export class CodemodeExecutor extends WorkerEntrypoint<Env> implements CodemodeExecutionCapability {
  async execute(
    request: Parameters<CodemodeExecutionCapability["execute"]>[0],
    capabilities: CodemodeCapabilities,
  ) {
    return await createCodemodeBridgeExecution(
      bridgeCodemodeActivationServices(this.env),
      this.ctx,
    ).execute(request, capabilities);
  }
}
