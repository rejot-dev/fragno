import { describe, expect, test, vi } from "vitest";

import type { BashHostContext } from "./bash-host";
import type { CloudflareRuntime } from "./families/cloudflare-runtime";
import { createBackofficeToolContext } from "./tool-context";

const cloudflareRuntime: CloudflareRuntime = {
  browserRunExtract: vi.fn(),
  browserRunCapture: vi.fn(),
  browserRunCrawl: vi.fn(),
};

describe("createBackofficeToolContext", () => {
  test("keeps the singleton Cloudflare runtime available to registered commands", () => {
    const context = {
      cloudflare: { runtime: cloudflareRuntime },
      backofficeExecution: {
        actor: { type: "system", id: "system" },
        scope: { kind: "system" },
      },
      backofficeKernel: {},
      createBackofficeScopedContext: vi.fn(),
    } as unknown as BashHostContext;

    expect(createBackofficeToolContext(context).runtimes.cloudflare).toBe(cloudflareRuntime);
  });
});
