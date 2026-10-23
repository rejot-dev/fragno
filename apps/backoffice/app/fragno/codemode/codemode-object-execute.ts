import { AsyncLocalStorage } from "node:async_hooks";

import type {
  CodemodeHost,
  CodemodeWorkflowHost,
} from "@fragno-dev/codemode/execution/codemode-activation-contract";
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

/**
 * Names a run to its Codemode object, with the run whose tool call started it. A child runs on its
 * parent's slot, which the parent does not use while it waits, so nested runs cannot exhaust their
 * scope's slots.
 */
export type CodemodeRunLease = { key: string; parentKey: string | null };

/**
 * The tools a run's guest can call, and the `provider.tool` names whose results its history must not
 * keep, such as a credential a tool returns once.
 */
export type CodemodeRunTools = {
  providers: readonly ResolvedProvider[];
  redactedResults: readonly string[];
};

/** A run's host, the lease that relates the runs its tools start to it, and its redactions. */
export type CodemodeRunHost = {
  host: CodemodeHost;
  lease: CodemodeRunLease;
  redactedResults: readonly string[];
};

// Tool calls run on the caller's side, so the caller, not the guest, knows which run started one.
const runningTool = new AsyncLocalStorage<string>();

/** Creates a run's host; a run that its tools start, such as through js.run, is its child. */
export function createCodemodeRunHost(
  { providers, redactedResults }: CodemodeRunTools,
  step: CodemodeWorkflowHost | null,
): CodemodeRunHost {
  const lease = { key: crypto.randomUUID(), parentKey: runningTool.getStore() ?? null };
  const toolsOfRun = providers.map((provider) => ({
    ...provider,
    fns: Object.fromEntries(
      Object.entries(provider.fns).map(([name, fn]) => [
        name,
        (...args: unknown[]) => runningTool.run(lease.key, () => fn(...args)),
      ]),
    ),
  }));
  return { host: createCodemodeHost(toolsOfRun, step), lease, redactedResults };
}

/** Runs code on behalf of one execution; callers name only what they run. */
export type CodemodeRunner = {
  run<TActivation extends CodemodeRunActivation>(
    activation: TActivation,
    origin: CodemodeRunOrigin,
    runHost: CodemodeRunHost,
  ): Promise<CodemodeExecution<TActivation>>;
};

/**
 * Binds a scope's Codemode object to the provenance of the execution that obtained it. The object
 * records usage against its scope's root owner; callers cannot choose another payer.
 */
export function codemodeRunnerFor(
  codemode: CodemodeObject,
  execution: BackofficeExecutionContext,
): CodemodeRunner {
  const context = {
    actors: execution.actors,
    scopeRestriction: backofficeExecutionScopeRestriction(execution),
  };
  return {
    run: (activation, origin, { host, lease, redactedResults }) =>
      codemode.execute(activation, { ...context, origin }, host, lease, redactedResults),
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
export async function executeCodemodeInObject<
  // Its host has no step capability; workflow ticks run through their own runner instead.
  TActivation extends Exclude<CodemodeRunActivation, { kind: "workflow" }>,
>(
  codemode: CodemodeRunner,
  activation: TActivation,
  origin: CodemodeRunOrigin,
  tools: CodemodeRunTools,
  signal: AbortSignal | null,
): Promise<CodemodeExecution<TActivation>> {
  signal?.throwIfAborted();
  const runHost = createCodemodeRunHost(tools, null);
  const { host } = runHost;
  const execution = codemode.run(activation, origin, runHost);
  if (signal === null) {
    return await execution;
  }
  let rejectCancelled: (reason: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject;
  });
  const cancel = () => {
    void host.close();
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
