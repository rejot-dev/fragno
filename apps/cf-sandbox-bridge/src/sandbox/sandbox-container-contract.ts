/**
 * Sandboxes reach Backoffice at this origin. Every sandbox's container intercepts it into Backoffice,
 * so it works without a public route from the container to Backoffice.
 */
export const SANDBOX_BACKOFFICE_HOST = "backoffice.internal";
export const SANDBOX_BACKOFFICE_ORIGIN = `http://${SANDBOX_BACKOFFICE_HOST}`;

/** Images a sandbox can start from. A saved workspace stays on the image it was created from. */
export const SANDBOX_IMAGES = ["workspace", "debian"] as const;
export type SandboxImage = (typeof SANDBOX_IMAGES)[number];

export const SANDBOX_INSTANCE_TYPES = [
  "lite",
  "standard-1",
  "standard-2",
  "standard-3",
  "standard-4",
] as const;
export type SandboxInstanceType = (typeof SANDBOX_INSTANCE_TYPES)[number];

export type SandboxStartSource =
  | { kind: "image"; image: SandboxImage }
  | { kind: "snapshot"; snapshotId: string };

export type SandboxStartRequest = {
  source: SandboxStartSource;
  instanceType: SandboxInstanceType;
  /**
   * Epoch milliseconds after which the sandbox stops itself without saving its workspace. Its
   * manager stops it earlier; this only bounds the cost of a manager that never does. Null keeps
   * the sandbox running until it is stopped.
   */
  leaseExpiresAt: number | null;
};

export type SandboxStartOutcome = {
  /** The original restoration time, also returned by idempotent starts of the same container. */
  restoredSnapshot: { id: string; restoredAt: string } | null;
};

export type SandboxExecRequest = {
  argv: string[];
  timeoutMs: number;
};

export type SandboxExecOutcome =
  | { status: "exited"; exitCode: number; stdout: string; stderr: string }
  | { status: "timed_out"; stdout: string; stderr: string }
  | { status: "output_limit_exceeded"; limitBytes: number }
  | { status: "not_running" };

export type SandboxContainerSnapshot = {
  id: string;
  size: number;
};

export type SandboxSnapshotOutcome =
  | { status: "saved"; snapshot: SandboxContainerSnapshot }
  | { status: "not_running" };

/** Operations on one physical sandbox, reached through Durable Object RPC or the bridge HTTP API. */
export interface SandboxContainerControl {
  start(request: SandboxStartRequest): Promise<SandboxStartOutcome>;
  exec(request: SandboxExecRequest): Promise<SandboxExecOutcome>;
  snapshot(): Promise<SandboxSnapshotOutcome>;
  stop(): Promise<void>;
}
