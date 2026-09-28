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
      const failures: Error[] = [];
      async function runAlarmDrainStage(name: string, stage: () => Promise<void>): Promise<void> {
        try {
          await stage();
        } catch (cause) {
          failures.push(new Error(`Node Backoffice alarm drain failed during ${name}.`, { cause }));
        }
      }

      await runAlarmDrainStage("persisted object discovery", runtime.discoverPersistedObjects);
      await runAlarmDrainStage("pre-alarm waitUntil drain", runtime.drainWaitUntil);
      await runAlarmDrainStage("alarm delivery", runtime.drainAlarms);
      await runAlarmDrainStage("post-alarm waitUntil drain", runtime.drainWaitUntil);

      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "One or more Node Backoffice alarm drain stages failed.",
        );
      }
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
