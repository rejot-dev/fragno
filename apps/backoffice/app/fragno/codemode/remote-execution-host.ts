import { createCodemodeHost } from "@fragno-dev/codemode/host/codemode-host-capabilities";
import { sanitizeToolName, type ResolvedProvider } from "@fragno-dev/codemode/runtime-api";

import type { BackofficeWorkflowStepHost } from "./workflow-host";

/** Keeps tool authority and workflow checkpoints on the host; only revocable RPC capabilities leave it. */
export function createBackofficeCodemodeRemoteHost(
  providers: ResolvedProvider[],
  workflow: { step: BackofficeWorkflowStepHost } | null,
) {
  return {
    host: createCodemodeHost(providers, workflow?.step ?? null),
    manifest: providers.map((provider) => ({
      name: provider.name,
      tools: Object.keys(provider.fns).map(sanitizeToolName),
    })),
  };
}
