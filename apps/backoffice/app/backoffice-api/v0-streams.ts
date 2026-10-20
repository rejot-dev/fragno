import type { BackofficeApiStreamImplementation } from "@fragno-dev/backoffice-api/api";
import type { backofficeApiV0 } from "@fragno-dev/backoffice-api/v0";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { watchPiManagerAgent } from "@/fragno/pi/manager/pi-manager-runtime";

/** What a stream handler runs with; `signal` aborts when the caller disconnects. */
export type BackofficeApiStreamContext = {
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  signal: AbortSignal;
};

/**
 * Streams are not runtime tools: Bash and Codemode cannot consume a response that never ends. Each
 * handler's source authorizes the stream's permissions through the kernel.
 */
export const backofficeApiV0Streams: BackofficeApiStreamImplementation<
  typeof backofficeApiV0,
  BackofficeApiStreamContext
> = {
  // The Pi manager's frames are the contract's frames, so they pass through unparsed.
  "pi.agent.watch": async ({ agentName }, context) =>
    await watchPiManagerAgent({ ...context, agentName }),
};
