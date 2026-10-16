import type { CodemodeHost } from "@fragno-dev/codemode/execution/codemode-activation-contract";
import { createCodemodeHost } from "@fragno-dev/codemode/host/codemode-host-capabilities";
import { sanitizeToolName, type ResolvedProvider } from "@fragno-dev/codemode/runtime-api";

import {
  backofficeExecutionScopeRestriction,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { CodemodeObject } from "@/backoffice-runtime/object-registry";

import type {
  CodemodeExecution,
  CodemodeRunActivation,
  CodemodeRunOrigin,
} from "./codemode-fragment";

/** Runs code on behalf of one execution; callers name only what they run. */
export type CodemodeRunner = {
  run(
    activation: CodemodeRunActivation,
    origin: CodemodeRunOrigin,
    host: CodemodeHost,
  ): Promise<CodemodeExecution>;
};

/**
 * Binds a scope's Codemode object to the provenance of the execution that obtained it. The object
 * bills its scope's organization when it has one, so the billing choice matters only elsewhere.
 */
export function codemodeRunnerFor(
  codemode: CodemodeObject,
  execution: BackofficeExecutionContext,
  billingOrganizationId: string | null,
): CodemodeRunner {
  const context = {
    actors: execution.actors,
    scopeRestriction: backofficeExecutionScopeRestriction(execution),
    billingOrganizationId,
  };
  return {
    run: (activation, origin, host) => codemode.execute(activation, { ...context, origin }, host),
  };
}

/** Advertises the caller's tool names to the guest; the tools themselves stay in the caller's host. */
export function codemodeProviderManifest(providers: readonly ResolvedProvider[]) {
  return providers.map((provider) => ({
    name: provider.name,
    tools: Object.keys(provider.fns).map(sanitizeToolName),
  }));
}

/** The Codemode object owns the guest and host lifecycle; a cancelled caller only revokes its host. */
export async function executeCodemodeInObject(
  codemode: CodemodeRunner,
  activation: CodemodeRunActivation,
  origin: CodemodeRunOrigin,
  providers: ResolvedProvider[],
  signal: AbortSignal | null,
): Promise<CodemodeExecution> {
  signal?.throwIfAborted();
  const host = createCodemodeHost(providers, null);
  const execution = codemode.run(activation, origin, host);
  if (signal === null) {
    return await execution;
  }
  let rejectCancelled: (reason: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject;
  });
  const cancel = () => {
    host.close();
    rejectCancelled(signal.reason);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    // The abandoned run keeps executing with revoked capabilities until the object records its outcome.
    return await Promise.race([execution, cancelled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
