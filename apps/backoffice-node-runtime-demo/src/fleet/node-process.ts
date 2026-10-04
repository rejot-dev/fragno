import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { requireNodeReadyMessage, type NodeReadyMessage } from "../node/node-ready-message";
import { openFilesystemGraftStorage } from "./local-filesystem-graft-storage";

const serverModule = new URL("../start-node.js", import.meta.url);
const NODE_START_TIMEOUT_MS = 60_000;

/** Exit status after the operating system reaps a managed runtime node process. */
export type DemoNodeExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

/** Starts a runtime node with its own cache and exact loopback peer address. */
export type DemoNodeProcessOptions = {
  environment: NodeJS.ProcessEnv;
  slot: string;
  dataDirectory: string;
  cacheDirectory: string;
  peerAuthenticationSecret: string;
  alarmIntervalMs: number;
  leaseDurationMs: number;
};

/** A serving child runtime node with explicit graceful-stop and hard-crash controls. */
export class DemoNodeProcess {
  readonly slot: string;
  readonly cacheDirectory: string;
  readonly applicationOrigin: string;
  readonly internalOrigin: string;
  readonly peerWebSocketAddress: string;
  readonly nodeId: string;
  readonly processGeneration: string;
  readonly processId: number;
  readonly exit: Promise<DemoNodeExit>;

  readonly #child: ChildProcess;

  private constructor(
    child: ChildProcess,
    options: DemoNodeProcessOptions,
    ready: NodeReadyMessage,
    exit: Promise<DemoNodeExit>,
  ) {
    if (child.pid === undefined) {
      throw new Error("DEMO_NODE_PROCESS_ID_MISSING");
    }
    this.#child = child;
    this.slot = options.slot;
    this.cacheDirectory = options.cacheDirectory;
    this.applicationOrigin = ready.applicationOrigin;
    this.internalOrigin = ready.internalOrigin;
    this.peerWebSocketAddress = ready.peerWebSocketAddress;
    this.nodeId = ready.nodeId;
    this.processGeneration = ready.processGeneration;
    this.processId = child.pid;
    this.exit = exit;
  }

  /** Starts one node with an isolated cache and shared durable fleet storage. */
  static async start(options: DemoNodeProcessOptions): Promise<DemoNodeProcess> {
    const storage = await openFilesystemGraftStorage(options.dataDirectory, options.cacheDirectory);
    const child = spawn(process.execPath, [serverModule.pathname], {
      cwd: path.dirname(serverModule.pathname),
      env: {
        ...options.environment,
        GRAFT_CONFIG: storage.configPath,
        HOST: "127.0.0.1",
        PORT: "0",
        BACKOFFICE_NODE_RUNTIME_DEMO_CONTROL_REMOTE_LOG_ID: storage.controlRemoteLogId,
        BACKOFFICE_NODE_RUNTIME_DEMO_APPLICATION_ORIGIN: undefined,
        BACKOFFICE_NODE_RUNTIME_DEMO_INTERNAL_ORIGIN: undefined,
        BACKOFFICE_NODE_RUNTIME_DEMO_INTERNAL_HOST: "127.0.0.1",
        BACKOFFICE_NODE_RUNTIME_DEMO_INTERNAL_PORT: "0",
        BACKOFFICE_NODE_RUNTIME_DEMO_ALARM_INTERVAL_MS: String(options.alarmIntervalMs),
        BACKOFFICE_NODE_RUNTIME_DEMO_LEASE_DURATION_MS: String(options.leaseDurationMs),
        BACKOFFICE_NODE_RUNTIME_DEMO_PEER_AUTHENTICATION_SECRET: options.peerAuthenticationSecret,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const ready = Promise.withResolvers<NodeReadyMessage>();
    const exit = Promise.withResolvers<DemoNodeExit>();
    let stderr = "";

    if (!child.stdout || !child.stderr) {
      child.kill("SIGKILL");
      throw new Error("DEMO_NODE_OUTPUT_PIPE_MISSING");
    }

    pipeNodeOutput(child.stdout, options.slot, console.log);
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[${options.slot}] ${text}`);
    });
    child.on("message", (message) => {
      try {
        ready.resolve(requireNodeReadyMessage(message));
      } catch (error) {
        ready.reject(error);
      }
    });
    child.once("error", (error) => {
      ready.reject(error);
    });
    child.once("exit", (code, signal) => {
      const result = { code, signal };
      exit.resolve(result);
      ready.reject(
        new Error(
          `DEMO_NODE_EXITED_BEFORE_READY:${options.slot}:${String(code)}:${String(signal)}:${stderr}`,
        ),
      );
    });

    const timeout = setTimeout(() => {
      ready.reject(new Error(`DEMO_NODE_START_TIMEOUT:${options.slot}`));
    }, NODE_START_TIMEOUT_MS);
    timeout.unref();

    try {
      const identity = await ready.promise;
      return new DemoNodeProcess(child, options, identity, exit.promise);
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Sends SIGTERM and waits for the runtime host's bounded graceful drain. */
  async stop(maximumWaitMs: number): Promise<void> {
    this.#child.kill("SIGTERM");
    const result = await waitForNodeExit(this.exit, maximumWaitMs, this.slot);
    if (result.code !== 0) {
      throw new Error(
        `DEMO_NODE_STOP_FAILED:${this.slot}:${String(result.code)}:${String(result.signal)}`,
      );
    }
  }

  /** Sends SIGKILL and waits until the operating system reaps the node process. */
  async crash(): Promise<void> {
    this.#child.kill("SIGKILL");
    await this.exit;
  }
}

function pipeNodeOutput(
  stream: NodeJS.ReadableStream,
  slot: string,
  writeLine: (line: string) => void,
): void {
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) {
        writeLine(`[${slot}] ${line}`);
      }
    }
  });
}

async function waitForNodeExit(
  exit: Promise<DemoNodeExit>,
  maximumWaitMs: number,
  slot: string,
): Promise<DemoNodeExit> {
  const timeout = Promise.withResolvers<never>();
  const handle = setTimeout(() => {
    timeout.reject(new Error(`DEMO_NODE_STOP_TIMEOUT:${slot}:${maximumWaitMs}`));
  }, maximumWaitMs);
  handle.unref();
  try {
    return await Promise.race([exit, timeout.promise]);
  } finally {
    clearTimeout(handle);
  }
}
