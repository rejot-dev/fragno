import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";

import type { SandboxInstanceStatus } from "@/sandbox/contracts";

export type SandboxRuntimeStatus = {
  status: SandboxInstanceStatus;
};

export class Sandbox extends CloudflareSandbox<CloudflareEnv> {
  async getRuntimeStatus(): Promise<SandboxRuntimeStatus> {
    return {
      status: this.ctx.container?.running ? "running" : "stopped",
    };
  }
}
