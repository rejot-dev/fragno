import { CODEMODE_LIMITS } from "../codemode-limits";
import { runWithCodemodeCompilerAdmission } from "../compiler/codemode-compiler-admission";
import type { CompiledWorker, WorkerCompiler } from "../compiler/compile-worker";
import { createCodemodeFunctionSource } from "../guest/codemode-function-source";
import { createCodemodeProviderProxySource } from "../guest/codemode-guest-api-source";
import { createCodemodeModuleInvocationSource } from "../guest/codemode-module-invocation-source";
import { createCodemodeModuleSource } from "../guest/codemode-module-source";
import {
  DynamicWorkerExecutor,
  type DynamicWorkerRpcCall,
} from "../guest/codemode-worker-executor";
import { createCodemodeWorkflowSource } from "../guest/codemode-workflow-source";
import { createCodemodeDispatchers } from "../host/codemode-tool-dispatcher";
import {
  codemodeWorkerEvaluationSchema,
  type CodemodeWorkerEvaluation,
  type ResolvedProvider,
} from "../runtime-api";
import {
  codemodeSuspensionReasonSchema,
  type CodemodeActivation,
  type CodemodeCapabilities,
  type CodemodeCompletion,
} from "./codemode-activation-contract";
import { CodemodeInterruptedError, encodeCodemodeError } from "./codemode-errors";
import { CODEMODE_WORKER_RUNTIME } from "./codemode-worker-bundle";

/** The bridge supplies compilation and Worker Loader; Node never loads guest code. */
export type CodemodeActivationServices = { loader: WorkerLoader; compile: WorkerCompiler | null };

type WorkflowResult =
  | { ok: true; result: unknown; logs: string[] }
  | { ok: false; suspension: { reason: unknown }; logs: string[] };

function collectCodemodeCompletionLogs(warnings: string[], guestLogs: string[]): string[] {
  const logs: string[] = [];
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const group of [warnings, guestLogs]) {
    for (const line of group) {
      const lineBytes = encoder.encode(line).byteLength;
      if (
        logs.length >= CODEMODE_LIMITS.maxLogs ||
        bytes + lineBytes > CODEMODE_LIMITS.maxLogBytes
      ) {
        // Preserve the execution outcome: diagnostics overflow must not turn success into a retry.
        const marker = "[codemode] Logs truncated.";
        const markerBytes = encoder.encode(marker).byteLength;
        while (
          logs.length >= CODEMODE_LIMITS.maxLogs ||
          bytes + markerBytes > CODEMODE_LIMITS.maxLogBytes
        ) {
          bytes -= encoder.encode(logs.pop()).byteLength;
        }
        logs.push(marker);
        return logs;
      }
      logs.push(line);
      bytes += lineBytes;
    }
  }
  return logs;
}

/** Builds or invokes one sealed guest; precompiled activations do not acquire compiler admission. */
export async function executeCodemodeActivation(
  activation: CodemodeActivation,
  services: CodemodeActivationServices,
  rpcTargets: CodemodeCapabilities,
  signal: AbortSignal,
  interrupt: (error: Error) => void,
): Promise<CodemodeCompletion> {
  const providers: ResolvedProvider[] = (
    activation.kind === "module-build" ? [] : activation.providers
  ).map((provider) => ({
    name: provider.name,
    fns: Object.fromEntries(provider.tools.map((tool) => [tool, async () => undefined])),
  }));
  const validation = createCodemodeDispatchers(providers);
  if ("error" in validation) {
    throw new Error(validation.error);
  }
  const executor = new DynamicWorkerExecutor({
    loader: services.loader,
    globalOutbound: null,
  });
  let compiled: CompiledWorker;
  if (activation.kind === "compiled") {
    if (
      activation.invocation !== null &&
      new TextEncoder().encode(activation.invocation).byteLength > CODEMODE_LIMITS.maxSourceBytes
    ) {
      throw new Error("CODEMODE_SOURCE_LIMIT_EXCEEDED");
    }
    // A trusted consumer supplies its adapter at execution; the saved bundle stays consumer-neutral.
    let mainModule = "__fragno_module_invocation__.js";
    while (Object.hasOwn(activation.bundle.modules, mainModule)) {
      mainModule = `_${mainModule}`;
    }
    compiled = {
      bundle: {
        ...activation.bundle,
        mainModule,
        modules: {
          ...activation.bundle.modules,
          [mainModule]:
            activation.invocation === null
              ? createCodemodeModuleSource(
                  `./${activation.bundle.mainModule}`,
                  providers,
                  activation.timeoutMs,
                )
              : createCodemodeModuleInvocationSource(
                  activation.invocation,
                  providers,
                  activation.timeoutMs,
                  `./${activation.bundle.mainModule}`,
                ),
        },
      },
      warnings: [],
    };
  } else {
    const sourceBytes =
      new TextEncoder().encode(activation.code).byteLength +
      (activation.kind === "module-invoke"
        ? new TextEncoder().encode(activation.invocation).byteLength
        : 0);
    if (sourceBytes > CODEMODE_LIMITS.maxSourceBytes) {
      throw new Error("CODEMODE_SOURCE_LIMIT_EXCEEDED");
    }
    if (!services.compile) {
      throw new Error("CODEMODE_COMPILER_UNAVAILABLE");
    }
    const code = activation.code.trim().replace(/;*$/, "");
    const files: Record<string, string> =
      activation.kind === "workflow"
        ? {
            "executor.js": createCodemodeWorkflowSource({
              code,
              providerProxySource: createCodemodeProviderProxySource(providers),
            }),
          }
        : activation.kind === "module-build"
          ? { "script.js": activation.code }
          : activation.kind === "module-invoke"
            ? {
                "executor.js": createCodemodeModuleInvocationSource(
                  activation.invocation,
                  providers,
                  activation.timeoutMs,
                  "./script.js",
                ),
                "script.js": activation.code,
              }
            : activation.kind === "module"
              ? {
                  "executor.js": createCodemodeModuleSource(
                    "./script.js",
                    providers,
                    activation.timeoutMs,
                  ),
                  "script.js": activation.code,
                }
              : {
                  "executor.js": createCodemodeFunctionSource(
                    code,
                    providers,
                    activation.timeoutMs,
                  ),
                };
    const compileDeadline = setTimeout(() => {
      interrupt(new CodemodeInterruptedError("CODEMODE_COMPILATION_TIMED_OUT"));
    }, CODEMODE_LIMITS.compileTimeoutMs);
    const compile = services.compile;
    try {
      compiled = await runWithCodemodeCompilerAdmission(() =>
        compile({
          files,
          entryPoint: activation.kind === "module-build" ? "script.js" : "executor.js",
          dependencies: activation.dependencies,
          runtime: CODEMODE_WORKER_RUNTIME,
        }),
      );
    } finally {
      clearTimeout(compileDeadline);
    }
  }
  signal.throwIfAborted();
  const bundleBytes = Object.values(compiled.bundle.modules).reduce(
    (size, source) => size + new TextEncoder().encode(source).byteLength,
    0,
  );
  if (bundleBytes > CODEMODE_LIMITS.maxBundleBytes) {
    throw new Error("CODEMODE_BUNDLE_LIMIT_EXCEEDED");
  }
  if (activation.kind === "module-build") {
    return { status: "completed", value: compiled, logs: [], workflowDefinition: null };
  }
  const common = { bundle: compiled.bundle, rpcTargets };
  const execution = {
    signal,
    limits: { cpuMs: CODEMODE_LIMITS.cpuMs, subRequests: CODEMODE_LIMITS.subRequests },
  };
  if (activation.kind === "workflow") {
    const output = await executor.runEntrypoint<
      {
        run(
          event: unknown,
          step: unknown,
          dispatchers: unknown,
        ): DynamicWorkerRpcCall<WorkflowResult>;
      },
      WorkflowResult
    >(
      {
        ...common,
        run: (entrypoint) =>
          entrypoint.run(activation.event, rpcTargets.stepTarget, rpcTargets.dispatchers),
      },
      execution,
    );
    const logs = collectCodemodeCompletionLogs(compiled.warnings, output.logs);
    return output.ok
      ? {
          status: "completed",
          value: output.result,
          logs,
          workflowDefinition: null,
        }
      : {
          status: "suspended",
          reason: codemodeSuspensionReasonSchema.parse(output.suspension.reason),
          logs,
        };
  }
  const evaluation = await executor.runEntrypoint<
    { evaluate(targets: unknown): DynamicWorkerRpcCall<CodemodeWorkerEvaluation> },
    CodemodeWorkerEvaluation
  >(
    {
      ...common,
      run: (entrypoint) =>
        entrypoint.evaluate({
          __dispatchers: rpcTargets.dispatchers,
          __input: activation.kind === "compiled" ? activation.input : undefined,
        }),
    },
    execution,
  );
  const output = codemodeWorkerEvaluationSchema.parse(evaluation);
  const logs = collectCodemodeCompletionLogs(compiled.warnings, output.logs);
  return !output.ok
    ? { status: "failed", error: encodeCodemodeError(new Error(output.error)), logs }
    : {
        status: "completed",
        value: output.result,
        logs,
        workflowDefinition: output.workflowDefinition
          ? { name: output.workflowDefinition.name, options: output.workflowDefinition.options }
          : null,
      };
}
