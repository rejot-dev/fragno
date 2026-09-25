import {
  parseOutboxBenchmarkServerMessage,
  type OutboxBenchmarkClientMessage,
  type OutboxBenchmarkClientResult,
} from "./outbox-benchmark-protocol";
import {
  openOutboxClientWorkloads,
  prepareLiveOutboxClientWorkloads,
} from "./outbox-client-workload";

if (!process.send || !process.disconnect) {
  throw new Error("Outbox benchmark client requires a parent IPC channel.");
}
const ipcProcess = process as NodeJS.Process & {
  send: NonNullable<NodeJS.Process["send"]>;
  disconnect: NonNullable<NodeJS.Process["disconnect"]>;
};

let closeWorkload: () => Promise<void> = async () => {};
let runWorkload: (() => Promise<OutboxBenchmarkClientResult>) | undefined;
let started = false;
let running = false;

function sendOutboxBenchmarkMessage(message: OutboxBenchmarkClientMessage): void {
  ipcProcess.send(message);
}

async function handleOutboxBenchmarkServerMessage(input: unknown): Promise<void> {
  const message = parseOutboxBenchmarkServerMessage(input);
  if (message.type === "close") {
    await closeWorkload();
    ipcProcess.disconnect();
    return;
  }
  if (message.type === "run") {
    if (!runWorkload || running) {
      throw new Error("Outbox benchmark client received run before a prepared workload.");
    }
    running = true;
    try {
      sendOutboxBenchmarkMessage({ type: "complete", result: await runWorkload() });
    } catch (error) {
      sendOutboxBenchmarkMessage({
        type: "failed",
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
    return;
  }
  if (started) {
    throw new Error("Outbox benchmark client received more than one workload.");
  }

  started = true;
  try {
    if (message.config.workload.kind === "live") {
      const workload = await prepareLiveOutboxClientWorkloads(message.config);
      closeWorkload = workload.close;
      runWorkload = () => workload.result;
    } else {
      runWorkload = async () => {
        const workload = await openOutboxClientWorkloads(message.config);
        closeWorkload = workload.close;
        return workload.result;
      };
    }
    sendOutboxBenchmarkMessage({ type: "started" });
  } catch (error) {
    sendOutboxBenchmarkMessage({
      type: "failed",
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
}

process.on("message", (message) => {
  void handleOutboxBenchmarkServerMessage(message).catch((error: unknown) => {
    sendOutboxBenchmarkMessage({
      type: "failed",
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  });
});

sendOutboxBenchmarkMessage({ type: "ready" });
