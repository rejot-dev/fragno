import type {
  SandboxImage,
  SandboxInstanceType,
} from "@fragno-apps/cf-sandbox-bridge/sandbox/sandbox-container-contract";

import type { SandboxInstanceStatus } from "@/sandbox/contracts";

/** One sandbox as the Computers pages show it. */
export type SandboxView = {
  id: string;
  status: SandboxInstanceStatus;
  image: SandboxImage;
  instanceType: SandboxInstanceType;
  /** Whether the next start resumes the workspace saved when the sandbox last stopped. */
  workspaceSaved: boolean;
  keepAlive: boolean;
  sleepAfter: string | number | null;
  startupCommand: string;
  startedAt: Date | null;
  expectedStopAt: Date | null;
  stoppedAt: Date | null;
  lastError: string | null;
};

export type NewSandboxFormValues = {
  id: string;
  keepAlive: boolean;
  /** Seconds, or duration text such as `15m` when resuming with a sandbox's saved setting. */
  sleepAfter: string;
  startupCommand: string;
  startupTimeoutSeconds: string;
  image: string;
  instanceType: string;
};

export const DEFAULT_NEW_SANDBOX_VALUES: NewSandboxFormValues = {
  id: "",
  keepAlive: false,
  sleepAfter: "900",
  startupCommand: "true",
  startupTimeoutSeconds: "15",
  image: "workspace",
  instanceType: "lite",
};

export type StartSandboxResult =
  | { ok: true; sandboxId: string }
  | { ok: false; message: string; values: NewSandboxFormValues };
