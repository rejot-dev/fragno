import type { LocalBackofficeRuntime } from "./local-runtime";

export type NodeBackofficeAlarmScheduler = {
  /** Stops future alarm polls and waits for the active local object alarm drain to finish. */
  stop(): Promise<void>;
};

/** Services alarms owned by local objects; Fragno durable hooks use their Node dispatcher instead. */
export function startNodeBackofficeAlarmScheduler(
  runtime: Pick<
    LocalBackofficeRuntime,
    "discoverPersistedObjects" | "drainAlarms" | "drainWaitUntil"
  >,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
): NodeBackofficeAlarmScheduler {
  const intervalMs = options.intervalMs ?? 1_000;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error("Node Backoffice alarm drain failed", error);
    });
  let stopped = false;
  let activeAlarmDrain: Promise<void> | null = null;

  const interval = setInterval(() => {
    if (stopped || activeAlarmDrain) {
      return;
    }

    const alarmDrain = (async () => {
      await runtime.discoverPersistedObjects();
      await runtime.drainWaitUntil();
      await runtime.drainAlarms();
      await runtime.drainWaitUntil();
    })().catch(onError);
    const trackedAlarmDrain = alarmDrain.finally(() => {
      if (activeAlarmDrain === trackedAlarmDrain) {
        activeAlarmDrain = null;
      }
    });
    activeAlarmDrain = trackedAlarmDrain;
  }, intervalMs);

  return {
    async stop() {
      stopped = true;
      clearInterval(interval);
      await activeAlarmDrain;
    },
  };
}
