import {
  parseOutboxBenchmarkServerMessage,
  type OutboxBenchmarkClientMessage,
} from "./outbox-benchmark-protocol";
import { openOutboxClientWorkload } from "./outbox-client-workload";

if (!process.send || !process.disconnect) {
  throw new Error("Outbox benchmark client requires a parent IPC channel.");
}
const ipcProcess = process as NodeJS.Process & {
  send: NonNullable<NodeJS.Process["send"]>;
  disconnect: NonNullable<NodeJS.Process["disconnect"]>;
};

let closeWorkload: () => Promise<void> = async () => {};
let started = false;

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
  if (started) {
    throw new Error("Outbox benchmark client received more than one workload.");
  }

  started = true;
  try {
    const workload = await openOutboxClientWorkload(message.config);
    closeWorkload = workload.close;
    sendOutboxBenchmarkMessage({ type: "complete", result: workload.result });
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
