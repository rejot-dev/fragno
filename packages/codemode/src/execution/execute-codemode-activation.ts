import { CODEMODE_LIMITS } from "../codemode-limits";
import { runWithCodemodeCompilerAdmission } from "../compiler/codemode-compiler-admission";
import type { WorkerCompiler } from "../compiler/compile-worker";
import { createCodemodeFunctionSource } from "../guest/codemode-function-source";
import { createCodemodeProviderProxySource } from "../guest/codemode-guest-api-source";
import { createCodemodeModuleSource } from "../guest/codemode-module-source";
import {
  DynamicWorkerExecutor,
  type DynamicWorkerRpcCall,
} from "../guest/codemode-worker-executor";
import { createCodemodeWorkflowSource } from "../guest/codemode-workflow-source";
import { createCodemodeDispatchers } from "../host/codemode-tool-dispatcher";
import type { CodemodeWorkerEvaluation, ResolvedProvider } from "../runtime-api";
import {
  codemodeSuspensionReasonSchema,
  type CodemodeActivation,
  type CodemodeCapabilities,
  type CodemodeCompletion,
} from "./codemode-activation-contract";
import { CodemodeInterruptedError, encodeCodemodeError } from "./codemode-errors";

/** The bridge supplies compilation and Worker Loader; Node never loads guest code. */
export type CodemodeActivationServices = { loader: WorkerLoader; compile: WorkerCompiler };

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

/** Generates, compiles, and invokes one guest; activation kind selects evaluate() or run(event, step). */
export async function executeCodemodeActivation(
  activation: CodemodeActivation,
  services: CodemodeActivationServices,
  rpcTargets: CodemodeCapabilities,
  signal: AbortSignal,
  interrupt: (error: Error) => void,
): Promise<CodemodeCompletion> {
  if (new TextEncoder().encode(activation.code).byteLength > CODEMODE_LIMITS.maxSourceBytes) {
    throw new Error("CODEMODE_SOURCE_LIMIT_EXCEEDED");
  }
  const providers: ResolvedProvider[] = activation.providers.map((provider) => ({
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
  const code = activation.code.trim().replace(/;*$/, "");
  const files: Record<string, string> =
    activation.kind === "workflow"
      ? {
          "executor.js": createCodemodeWorkflowSource({
            code,
            providerProxySource: createCodemodeProviderProxySource(providers),
          }),
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
        : { "executor.js": createCodemodeFunctionSource(code, providers, activation.timeoutMs) };
  const compileDeadline = setTimeout(() => {
    interrupt(new CodemodeInterruptedError("CODEMODE_COMPILATION_TIMED_OUT"));
  }, CODEMODE_LIMITS.compileTimeoutMs);
  let compiled;
  try {
    compiled = await runWithCodemodeCompilerAdmission(() =>
      services.compile({
        files,
        entryPoint: "executor.js",
        dependencies: activation.dependencies,
        runtime: { compatibilityDate: "2026-05-07", compatibilityFlags: ["nodejs_compat"] },
      }),
    );
  } finally {
    clearTimeout(compileDeadline);
  }
  signal.throwIfAborted();
  const bundleBytes = Object.values(compiled.bundle.modules).reduce(
    (size, source) => size + new TextEncoder().encode(source).byteLength,
    0,
  );
  if (bundleBytes > CODEMODE_LIMITS.maxBundleBytes) {
    throw new Error("CODEMODE_BUNDLE_LIMIT_EXCEEDED");
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
  const output = await executor.runEntrypoint<
    { evaluate(targets: unknown): DynamicWorkerRpcCall<CodemodeWorkerEvaluation> },
    CodemodeWorkerEvaluation
  >(
    {
      ...common,
      run: (entrypoint) => entrypoint.evaluate({ __dispatchers: rpcTargets.dispatchers }),
    },
    execution,
  );
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
