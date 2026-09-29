const nodeOpenTelemetryLifecycleKey = Symbol.for("fragno.backoffice.node-opentelemetry-lifecycle");
const nodeOpenTelemetryShutdownTimeoutMs = 5_000;

type NodeOpenTelemetryLifecycle = {
  shutdown(): Promise<void>;
};

function nodeOpenTelemetryGlobal(): typeof globalThis & {
  [nodeOpenTelemetryLifecycleKey]?: NodeOpenTelemetryLifecycle;
} {
  return globalThis;
}

/** Registers the process-wide Node OpenTelemetry lifecycle started by the preload module. */
export function registerNodeOpenTelemetryLifecycle(lifecycle: NodeOpenTelemetryLifecycle): void {
  nodeOpenTelemetryGlobal()[nodeOpenTelemetryLifecycleKey] = lifecycle;
}

/** Flushes and closes the process-wide Node OpenTelemetry SDK without delaying process shutdown. */
export async function shutdownNodeOpenTelemetry(): Promise<void> {
  const lifecycle = nodeOpenTelemetryGlobal()[nodeOpenTelemetryLifecycleKey];
  delete nodeOpenTelemetryGlobal()[nodeOpenTelemetryLifecycleKey];
  if (!lifecycle) {
    return;
  }

  let timeout: NodeJS.Timeout | null = null;
  const shutdownDeadline = new Promise<"timed-out">((resolve) => {
    timeout = setTimeout(() => {
      resolve("timed-out");
    }, nodeOpenTelemetryShutdownTimeoutMs);
    timeout.unref();
  });

  try {
    const result = await Promise.race([
      lifecycle.shutdown().then(() => {
        return "completed" as const;
      }),
      shutdownDeadline,
    ]);
    if (result === "timed-out") {
      console.warn(
        `Node OpenTelemetry shutdown exceeded ${nodeOpenTelemetryShutdownTimeoutMs}ms; continuing process shutdown.`,
      );
    }
  } catch (error) {
    console.warn("Node OpenTelemetry shutdown failed; continuing process shutdown.", error);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
