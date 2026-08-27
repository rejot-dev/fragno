import { describe, expect, test, vi } from "vitest";

import type { BashHostContext } from "./bash-host";
import type { CloudflareRuntime } from "./families/cloudflare-runtime";
import type { FormsRuntime } from "./families/forms-runtime";
import { createBackofficeToolContext } from "./tool-context";

const cloudflareRuntime: CloudflareRuntime = {
  browserRunCapture: vi.fn(),
  browserRunCrawl: vi.fn(),
};

const formsRuntime: FormsRuntime = {
  listForms: vi.fn(),
  createForm: vi.fn(),
  updateForm: vi.fn(),
  listSubmissions: vi.fn(),
};

describe("createBackofficeToolContext", () => {
  test("keeps the singleton Forms runtime available to registered commands", () => {
    const context = {
      forms: { runtime: formsRuntime },
      backofficeExecution: {
        actor: { type: "system", id: "system" },
        scope: { kind: "system" },
      },
      backofficeKernel: {},
      createBackofficeScopedContext: vi.fn(),
    } as unknown as BashHostContext;

    expect(createBackofficeToolContext(context).runtimes.forms).toBe(formsRuntime);
  });

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
