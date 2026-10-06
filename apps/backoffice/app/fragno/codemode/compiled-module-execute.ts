import { CODEMODE_LIMITS } from "@fragno-dev/codemode/codemode-limits";
import type { CompiledWorker } from "@fragno-dev/codemode/compiler/compile-worker";
import type { WorkerBundle } from "@fragno-dev/codemode/compiler/worker-bundle";
import type {
  CodemodeActivation,
  CodemodeCompletion,
} from "@fragno-dev/codemode/execution/codemode-activation-contract";
import { codemodeWorkerBundleSchema } from "@fragno-dev/codemode/execution/codemode-worker-bundle";
import { executeCodemodeActivation } from "@fragno-dev/codemode/execution/execute-codemode-activation";
import { createCodemodeHost } from "@fragno-dev/codemode/host/codemode-host-capabilities";
import type { ResolvedProvider } from "@fragno-dev/codemode/runtime-api";
import { z } from "zod";

import { resolveBackofficeWorkerCompiler, type BackofficeCodemodeEnv } from "./execute";

type ModuleBuildActivation = Extract<CodemodeActivation, { kind: "module-build" }>;
type CompiledModuleActivation = Extract<CodemodeActivation, { kind: "compiled" }>;

/** Bundles an ES module without executing it or choosing a consumer-specific entrypoint. */
export async function buildBackofficeJavaScriptModule(input: {
  code: string;
  dependencies: Record<string, string>;
  env: BackofficeCodemodeEnv;
}): Promise<CompiledWorker> {
  const completion = await runSealedModuleActivation(
    {
      kind: "module-build",
      code: input.code,
      dependencies: input.dependencies,
    },
    [],
    input.env,
    null,
  );
  return z
    .strictObject({ bundle: codemodeWorkerBundleSchema, warnings: z.array(z.string()) })
    .parse(requireCompletedModuleValue(completion));
}

type CompiledModuleExecutionInput = {
  bundle: WorkerBundle;
  invocation: string | null;
  input: unknown;
  providers: ResolvedProvider[];
  env: BackofficeCodemodeEnv;
  signal: AbortSignal | null;
};

/** Returns the module's value or raises its failure; consumers need not interpret execution logs. */
export async function runBackofficeCompiledModule(
  input: CompiledModuleExecutionInput,
): Promise<unknown> {
  return requireCompletedModuleValue(await executeBackofficeCompiledModule(input));
}

/** Executes a precompiled module with fresh capabilities and logs; null invocation runs top-level code only. */
export async function executeBackofficeCompiledModule(
  input: CompiledModuleExecutionInput,
): Promise<CodemodeCompletion> {
  return await runSealedModuleActivation(
    {
      kind: "compiled",
      bundle: input.bundle,
      invocation: input.invocation,
      input: input.input,
      providers: input.providers.map((provider) => ({
        name: provider.name,
        tools: Object.keys(provider.fns),
      })),
      timeoutMs: 10_000,
    },
    input.providers,
    input.env,
    input.signal,
  );
}

async function runSealedModuleActivation(
  activation: ModuleBuildActivation | CompiledModuleActivation,
  providers: ResolvedProvider[],
  env: BackofficeCodemodeEnv,
  parentSignal: AbortSignal | null,
): Promise<CodemodeCompletion> {
  parentSignal?.throwIfAborted();
  const host = createCodemodeHost(providers, null);
  const interrupted = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, interrupted.signal])
    : interrupted.signal;
  function revokeGuestCapabilities() {
    host.close();
  }
  signal.addEventListener("abort", revokeGuestCapabilities, { once: true });
  const deadline = setTimeout(
    () => {
      interrupted.abort(new Error("CODEMODE_MODULE_ACTIVATION_TIMED_OUT"));
    },
    ("remoteExecutor" in env ? CODEMODE_LIMITS.connectTimeoutMs : 0) +
      (activation.kind === "compiled" ? activation.timeoutMs : CODEMODE_LIMITS.activationTimeoutMs),
  );
  let rejectInterrupted: (error: unknown) => void;
  const cancellation = new Promise<never>((_, reject) => {
    rejectInterrupted = reject;
  });
  function rejectOnAbort() {
    rejectInterrupted(signal.reason);
  }
  signal.addEventListener("abort", rejectOnAbort, { once: true });
  let completion: CodemodeCompletion;
  let drained: boolean;
  try {
    const execution =
      "remoteExecutor" in env
        ? env.remoteExecutor(activation, host)
        : executeCodemodeActivation(
            activation,
            {
              loader: env.LOADER,
              compile: activation.kind === "compiled" ? null : resolveBackofficeWorkerCompiler(env),
            },
            host.capabilities,
            signal,
            (error) => {
              interrupted.abort(error);
            },
          );
    completion = await Promise.race([execution, cancellation]);
    signal.throwIfAborted();
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", rejectOnAbort);
    signal.removeEventListener("abort", revokeGuestCapabilities);
    host.close();
    // Revocation cannot stop an already-running tool. Keep settlement tracking alive without
    // letting unabortable work hold the caller past the bounded host drain window.
    const draining = host.settle();
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      drained = await Promise.race([
        draining.then(() => true),
        new Promise<boolean>((resolve) => {
          drainTimer = setTimeout(() => {
            resolve(false);
          }, CODEMODE_LIMITS.hostDrainTimeoutMs);
        }),
      ]);
    } finally {
      if (drainTimer !== null) {
        clearTimeout(drainTimer);
      }
    }
  }
  if (!drained) {
    throw new Error("CODEMODE_HOST_DRAIN_TIMED_OUT");
  }
  return completion;
}

function requireCompletedModuleValue(completion: CodemodeCompletion): unknown {
  if (completion.status === "failed") {
    throw new Error(completion.error.message);
  }
  if (completion.status === "suspended") {
    throw new Error("CODEMODE_MODULE_INVOCATION_CANNOT_SUSPEND");
  }
  return completion.value;
}
