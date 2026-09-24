import { fork, type ChildProcess, type Serializable } from "node:child_process";
import { once } from "node:events";

const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Wait for one validated IPC message without retaining listeners after completion. */
export function waitForBenchmarkChildMessage<T>(
  child: ChildProcess,
  parseMessage: (input: unknown) => T,
  benchmarkName: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    function cleanup() {
      child.off("message", handleMessage);
      child.off("error", handleError);
      child.off("exit", handleExit);
    }
    function handleMessage(input: unknown) {
      cleanup();
      try {
        resolve(parseMessage(input));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    function handleError(error: Error) {
      cleanup();
      reject(error);
    }
    function handleExit(code: number | null, signal: NodeJS.Signals | null) {
      cleanup();
      reject(
        new Error(
          `${benchmarkName} client exited before replying: code=${String(code)} signal=${String(signal)}.`,
        ),
      );
    }

    child.on("message", handleMessage);
    child.once("error", handleError);
    child.once("exit", handleExit);
  });
}

/** Send one typed benchmark IPC command and wait for Node to accept it. */
export function sendBenchmarkChildMessage(
  child: ChildProcess,
  message: Serializable,
): Promise<void> {
  return new Promise((resolve, reject) => {
    child.send(message, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/** Spawn an unmeasured TypeScript benchmark client with an IPC channel. */
export function forkBenchmarkClient(entrypoint: string): ChildProcess {
  return fork(entrypoint, [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
}

/** Request graceful client transport teardown, then kill a client that does not exit. */
export async function closeBenchmarkChild(
  child: ChildProcess,
  closeMessage: Serializable,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = once(child, "exit");
  await sendBenchmarkChildMessage(child, closeMessage).catch(() => {
    child.kill();
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      child.kill();
      resolve();
    }, CHILD_SHUTDOWN_TIMEOUT_MS);
    timeout.unref();
  });
  await Promise.race([exited, timedOut]);
  clearTimeout(timeout);
}
