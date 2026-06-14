import { describe, expect, it, vi } from "vitest";

import { createCloudflareBackofficeObjectRegistry } from "./cloudflare-durable-object-factory";

const createNamespace = () => {
  const namespace = {
    idFromName: vi.fn((name: string) => `id:${name}`),
    get: vi.fn((id: string) => ({ id })),
  };
  return namespace;
};

describe("createCloudflareBackofficeObjectRegistry", () => {
  it("routes org-scoped objects through Cloudflare namespaces", () => {
    const automations = createNamespace();
    const env = {
      AUTH: createNamespace(),
      AUTOMATIONS: automations,
      TELEGRAM: createNamespace(),
      OTP: createNamespace(),
      PI: createNamespace(),
      RESEND: createNamespace(),
      RESON8: createNamespace(),
      MCP: createNamespace(),
      UPLOAD: createNamespace(),
      GITHUB: createNamespace(),
      CLOUDFLARE_WORKERS: createNamespace(),
      GITHUB_WEBHOOK_ROUTER: createNamespace(),
      SANDBOX_REGISTRY: createNamespace(),
      SANDBOX: createNamespace(),
    } as unknown as CloudflareEnv;

    const objects = createCloudflareBackofficeObjectRegistry(env);
    objects.automations.forOrg("org-1");

    expect(automations.idFromName).toHaveBeenCalledWith("org-1");
    expect(automations.get).toHaveBeenCalledWith("id:org-1");
  });
});
