import {
  parsePiWorkflowBenchmarkServerMessage,
  type PiWorkflowBenchmarkClientMessage,
} from "./pi-workflow-benchmark-protocol";
import { preparePiWorkflowClientWorkload } from "./pi-workflow-client-workload";

if (!process.send || !process.disconnect) {
  throw new Error("Pi workflow benchmark client requires a parent IPC channel.");
}
const ipcProcess = process as NodeJS.Process & {
  send: NonNullable<NodeJS.Process["send"]>;
  disconnect: NonNullable<NodeJS.Process["disconnect"]>;
};

let workload: Awaited<ReturnType<typeof preparePiWorkflowClientWorkload>> | null = null;
let started = false;

function sendPiWorkflowBenchmarkMessage(message: PiWorkflowBenchmarkClientMessage): void {
  ipcProcess.send(message);
}

async function handlePiWorkflowBenchmarkServerMessage(input: unknown): Promise<void> {
  const message = parsePiWorkflowBenchmarkServerMessage(input);
  if (message.type === "close") {
    await workload?.close();
    ipcProcess.disconnect();
    return;
  }
  if (message.type === "prepare") {
    if (workload) {
      throw new Error("Pi workflow benchmark client received more than one preparation command.");
    }
    workload = await preparePiWorkflowClientWorkload(message.config);
    sendPiWorkflowBenchmarkMessage({ type: "prepared" });
    return;
  }
  if (!workload || started) {
    throw new Error("Pi workflow benchmark client received start outside the prepared state.");
  }

  started = true;
  const result = await workload.run();
  sendPiWorkflowBenchmarkMessage({ type: "complete", result });
}

process.on("message", (message) => {
  void handlePiWorkflowBenchmarkServerMessage(message).catch((error: unknown) => {
    sendPiWorkflowBenchmarkMessage({
      type: "failed",
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  });
});

sendPiWorkflowBenchmarkMessage({ type: "ready" });
