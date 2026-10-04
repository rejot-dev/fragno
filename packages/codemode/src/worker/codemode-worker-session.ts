import { CODEMODE_LIMITS } from "../codemode-limits";
import { runWithCodemodeCompilerAdmission } from "../compiler/codemode-compiler-admission";
import type { WorkerCompiler } from "../compiler/compile-worker";
import type { CodemodeWorkerEvaluation, ResolvedProvider } from "../runtime-api";
import { CodemodeInterruptedError, encodeCodemodeError } from "../transport/codemode-errors";
import { authenticateCodemodeHttpRequest } from "../transport/codemode-http-authentication";
import { CodemodePeer } from "../transport/codemode-peer";
import {
  codemodeGuestOperationSchema,
  codemodeSuspensionReasonSchema,
  type CodemodeActivation,
  type CodemodeCompletion,
} from "../transport/codemode-protocol";
import { createCodemodeDispatchers } from "./codemode-dispatcher";
import { DynamicWorkerExecutor, type DynamicWorkerRpcCall } from "./codemode-executor";
import {
  createCodemodeExpressionSource,
  createCodemodeModuleSource,
  createCodemodeProviderProxySource,
} from "./codemode-guest-source";
import { CodemodeGuestTargets } from "./codemode-guest-targets";
import { createRemoteWorkflowWorkerCode } from "./workflow-source";

type WorkerSessionEnv = { loader: WorkerLoader; compile: WorkerCompiler };
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

async function executeCodemodeActivation(
  activation: CodemodeActivation,
  env: WorkerSessionEnv,
  targets: CodemodeGuestTargets,
  signal: AbortSignal,
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
    loader: env.loader,
    globalOutbound: null,
  });
  const code = activation.code.trim().replace(/;*$/, "");
  const files: Record<string, string> =
    activation.kind === "workflow"
      ? {
          "executor.js": createRemoteWorkflowWorkerCode({
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
        : { "executor.js": createCodemodeExpressionSource(code, providers, activation.timeoutMs) };
  const compileDeadline = setTimeout(() => {
    targets.peer.close(new CodemodeInterruptedError("CODEMODE_COMPILATION_TIMED_OUT"));
  }, CODEMODE_LIMITS.compileTimeoutMs);
  let compiled;
  try {
    compiled = await runWithCodemodeCompilerAdmission(() =>
      env.compile({
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
  const rpcTargets = targets.create(activation);
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

/** Owns an ordinary accepted Worker socket; no durable state or background recovery is created. */
export function acceptCodemodeWorkerSocket(
  socket: WebSocket,
  env: WorkerSessionEnv,
  ctx: ExecutionContext,
): void {
  const abort = new AbortController();
  let deadline: ReturnType<typeof setTimeout>;
  let sentBytes = 0;
  const startedAt = Date.now();
  let identity: {
    executionId: string;
    kind: CodemodeActivation["kind"];
    workflowInstanceId: string | null;
  } | null = null;
  let outcome: CodemodeCompletion["status"] | "interrupted" = "interrupted";
  let targets: CodemodeGuestTargets;
  const peer = new CodemodePeer({
    role: "bridge",
    // Workers do not expose a drain callback. A conservative cumulative send budget also bounds
    // queued bytes even if the remote reader never drains a single frame.
    bufferedBytes: () => sentBytes,
    send(text) {
      socket.send(text);
      sentBytes += new TextEncoder().encode(text).byteLength;
    },
    close() {
      try {
        socket.close(1000, "Codemode activation ended");
      } catch {
        /* Peer may already be closed. */
      }
    },
    handle: (call) => targets.invoke(codemodeGuestOperationSchema.parse(call)),
    control(message) {
      if (message.type === "cancel") {
        peer.close(new CodemodeInterruptedError("CODEMODE_CANCELLED"));
        return;
      }
      if (message.type !== "start") {
        throw new Error("CODEMODE_WRONG_MESSAGE_ROLE");
      }
      identity = {
        executionId: message.executionId,
        kind: message.activation.kind,
        workflowInstanceId:
          message.activation.kind === "workflow" ? message.activation.event.instanceId : null,
      };
      clearTimeout(deadline);
      deadline = setTimeout(
        () => {
          peer.close(new CodemodeInterruptedError("CODEMODE_ACTIVATION_TIMED_OUT"));
        },
        message.activation.kind === "workflow"
          ? message.activation.timeoutMs
          : CODEMODE_LIMITS.activationTimeoutMs,
      );
      // Let settled compilation release admission even after its socket closes.
      ctx.waitUntil(
        (async () => {
          let completion: CodemodeCompletion;
          try {
            completion = await executeCodemodeActivation(
              message.activation,
              env,
              targets,
              abort.signal,
            );
          } catch (error) {
            completion = { status: "failed", error: encodeCodemodeError(error), logs: [] };
          }
          if (peer.closed) {
            return;
          }
          try {
            peer.send({ type: "complete", completion });
            outcome = completion.status;
          } finally {
            peer.close();
          }
        })().catch((error: unknown) => {
          peer.close(error instanceof Error ? error : new Error(String(error)));
        }),
      );
    },
    onClose(error) {
      clearTimeout(deadline);
      abort.abort(error);
      targets.close();
      if (identity) {
        console.info("codemode.activation", {
          ...identity,
          peer: "bridge",
          durationMs: Date.now() - startedAt,
          outcome,
          ...peer.metrics,
        });
      }
    },
  });
  targets = new CodemodeGuestTargets(peer);
  deadline = setTimeout(() => {
    peer.close(new CodemodeInterruptedError("CODEMODE_START_TIMED_OUT"));
  }, CODEMODE_LIMITS.startTimeoutMs);
  socket.addEventListener("message", (event) => {
    peer.receive(event.data);
  });
  socket.addEventListener("close", () => {
    peer.close();
  });
  socket.addEventListener("error", () => {
    peer.close();
  });
  socket.accept();
}

/** Authenticates before upgrade, including when the Sandbox bridge allows unauthenticated dev. */
export async function handleCodemodeWorkerRequest(
  request: Request,
  apiKey: string | undefined,
  env: WorkerSessionEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const authenticationError = await authenticateCodemodeHttpRequest(request, apiKey);
  if (authenticationError) {
    return authenticationError;
  }
  const url = new URL(request.url);
  if (url.pathname !== "/v1/codemode/execute" || url.search) {
    return new Response("Not found", { status: 404 });
  }
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required", { status: 426 });
  }
  const pair = new WebSocketPair();
  acceptCodemodeWorkerSocket(pair[1], env, ctx);
  return new Response(null, { status: 101, webSocket: pair[0] });
}
