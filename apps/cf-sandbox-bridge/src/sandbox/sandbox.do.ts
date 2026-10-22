import { DurableObject } from "cloudflare:workers";

import {
  COMMAND_KILL_GRACE_MS,
  createSandboxCommandInvocation,
  MAX_COMMAND_OUTPUT_BYTES,
} from "./sandbox-command-supervisor";
import type {
  SandboxContainerControl,
  SandboxExecOutcome,
  SandboxExecRequest,
  SandboxSnapshotOutcome,
  SandboxStartOutcome,
  SandboxStartRequest,
  SandboxStartSource,
} from "./sandbox-container-contract";
import { SANDBOX_BACKOFFICE_HOST } from "./sandbox-container-contract";

// Cloudflare stops a container shortly after its Durable Object goes idle. The alarm heartbeat keeps
// the object active for as long as the lease holds; the inactivity timeout outlives a missed beat.
const LEASE_HEARTBEAT_MS = 5 * 60_000;
const INACTIVITY_TIMEOUT_MS = 3 * LEASE_HEARTBEAT_MS;
const LEASE_STORAGE_KEY = "lease-expires-at";
const START_OUTCOME_STORAGE_KEY = "start-outcome";

// The bridge's main module exports this entrypoint; Workers that import this class type-check it
// against their own exports.
type BridgeExports = { SandboxBackofficeEgress: Fetcher };

const MANAGED_DEBIAN_IMAGE = "cloudflare/debian-trixie";
const WORKSPACE_DIRECTORY = "/workspace";
// Exec processes inherit only PATH from the image, so login shells need the rest spelled out.
const COMMAND_ENV = { HOME: "/root", LANG: "C.UTF-8" };
// JSON can escape each output byte as six characters; leave room for the outcome envelope.
const MAX_SUPERVISOR_OUTPUT_BYTES = 6 * MAX_COMMAND_OUTPUT_BYTES + 1024;
const SUPERVISOR_TRANSPORT_GRACE_MS = 1_000;

/**
 * One sandbox: a Linux container started, saved, and stopped by its manager. It reads no bindings,
 * so every Worker that hosts sandboxes can export it.
 */
export class Sandbox extends DurableObject<unknown> implements SandboxContainerControl {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    const container = ctx.container;
    // A restarted Durable Object starts without the timeout of a container that is still running.
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
    }
  }

  async start(request: SandboxStartRequest): Promise<SandboxStartOutcome> {
    const container = this.#container();
    const wasRunning = container.running;
    if (!wasRunning) {
      container.start({
        ...this.#startSource(container, request.source),
        instance: request.instanceType,
        entrypoint: ["sleep", "infinity"],
        enableInternet: true,
      });
    }
    try {
      // Re-registering replaces the intercept, so containers started before it existed gain it too.
      await container.interceptOutboundHttp(
        SANDBOX_BACKOFFICE_HOST,
        (this.ctx.exports as unknown as BridgeExports).SandboxBackofficeEgress,
      );
      let outcome: SandboxStartOutcome;
      if (wasRunning) {
        const stored = await this.ctx.storage.get<SandboxStartOutcome>(START_OUTCOME_STORAGE_KEY);
        if (stored === undefined) {
          throw new Error("The running sandbox has no startup metadata.");
        }
        outcome = stored;
      } else {
        outcome = {
          restoredSnapshot:
            request.source.kind === "snapshot"
              ? { id: request.source.snapshotId, restoredAt: new Date().toISOString() }
              : null,
        };
        // Preserve the actual restoration attempt time across retries and Durable Object eviction.
        await this.ctx.storage.put(START_OUTCOME_STORAGE_KEY, outcome);
      }
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      await this.ctx.storage.put(LEASE_STORAGE_KEY, request.leaseExpiresAt);
      await this.ctx.storage.setAlarm(Date.now() + LEASE_HEARTBEAT_MS);
      // The first exec waits for the container to boot, so this also surfaces a failed start.
      const process = await container.exec(["mkdir", "-p", WORKSPACE_DIRECTORY]);
      const exitCode = await process.exitCode;
      if (exitCode !== 0) {
        throw new Error(`Sandbox workspace setup exited with code ${exitCode}.`);
      }
      return outcome;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async exec({ argv, timeoutMs }: SandboxExecRequest): Promise<SandboxExecOutcome> {
    const container = this.#container();
    if (!container.running) {
      return { status: "not_running" };
    }
    const process = await container.exec(createSandboxCommandInvocation({ argv, timeoutMs }), {
      cwd: WORKSPACE_DIRECTORY,
      env: COMMAND_ENV,
    });
    let supervisorRunning = true;
    const exitCode = process.exitCode.finally(() => {
      supervisorRunning = false;
    });
    function stopSupervisor() {
      // Cloudflare treats signaling an exited exec process as an uncaught internal error.
      if (supervisorRunning) {
        process.kill(15);
      }
    }
    try {
      const output = await readSupervisorOutput(
        { stdout: process.stdout, stderr: process.stderr, exitCode },
        timeoutMs + COMMAND_KILL_GRACE_MS + SUPERVISOR_TRANSPORT_GRACE_MS,
        stopSupervisor,
      );
      if (output.exitCode !== 0) {
        throw new Error(
          `Sandbox command supervisor exited with code ${output.exitCode}: ${output.stderr}`,
        );
      }
      // The supervisor is our own producer; malformed output is an operational failure, not a
      // command result to recover from.
      return JSON.parse(output.stdout) as SandboxExecOutcome;
    } finally {
      stopSupervisor();
    }
  }

  async snapshot(): Promise<SandboxSnapshotOutcome> {
    const container = this.#container();
    if (!container.running) {
      return { status: "not_running" };
    }
    const snapshot = await container.snapshotContainer({});
    return { status: "saved", snapshot: { id: snapshot.id, size: snapshot.size } };
  }

  async stop(): Promise<void> {
    await this.ctx.storage.delete(LEASE_STORAGE_KEY);
    await this.ctx.storage.deleteAlarm();
    const container = this.#container();
    if (container.running) {
      await container.destroy();
    }
    await this.ctx.storage.delete(START_OUTCOME_STORAGE_KEY);
  }

  override async alarm(): Promise<void> {
    const leaseExpiresAt = await this.ctx.storage.get<number | null>(LEASE_STORAGE_KEY);
    if (leaseExpiresAt === undefined) {
      return;
    }
    if (!this.#container().running || (leaseExpiresAt !== null && Date.now() >= leaseExpiresAt)) {
      await this.stop();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + LEASE_HEARTBEAT_MS);
  }

  #container(): Container {
    const container = this.ctx.container;
    if (!container) {
      throw new Error("The Sandbox Durable Object has no container configured.");
    }
    return container;
  }

  #startSource(
    container: Container,
    source: SandboxStartSource,
  ): { image: string } | { containerSnapshot: { id: string } } {
    if (source.kind === "snapshot") {
      return { containerSnapshot: { id: source.snapshotId } };
    }
    if (source.image === "debian") {
      return { image: MANAGED_DEBIAN_IMAGE };
    }
    const image = container.images[source.image];
    if (!image) {
      throw new Error(`The Sandbox container has no "${source.image}" image configured.`);
    }
    return { image };
  }
}

/** Bounds protocol output and cleanup even if the supervisor itself fails to finish. */
async function readSupervisorOutput(
  process: Pick<ExecProcess, "stdout" | "stderr" | "exitCode">,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const readers = [process.stdout, process.stderr].map((stream) => stream?.getReader() ?? null);
  let remainingBytes = MAX_SUPERVISOR_OUTPUT_BYTES;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + timeoutMs;

  async function readText(reader: ReadableStreamDefaultReader<Uint8Array> | null) {
    if (!reader) {
      return "";
    }
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return text + decoder.decode();
      }
      remainingBytes -= value.byteLength;
      if (remainingBytes < 0) {
        throw new Error("Sandbox command supervisor exceeded its protocol output limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
  }

  const timeout = new Promise<never>((_, reject) => {
    function checkDeadline() {
      const remainingMs = deadline - Date.now();
      if (remainingMs > 0) {
        timer = setTimeout(checkDeadline, Math.min(remainingMs, 2_147_483_647));
        return;
      }
      onTimeout();
      reject(new Error(`Sandbox command supervisor did not finish within ${timeoutMs}ms.`));
    }
    checkDeadline();
  });
  try {
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([readText(readers[0]), readText(readers[1]), process.exitCode]),
      timeout,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
    await Promise.all(readers.flatMap((reader) => (reader ? [reader.cancel()] : [])));
  }
}
