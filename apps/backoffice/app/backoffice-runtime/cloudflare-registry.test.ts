import { describe, expect, it, vi } from "vitest";

import { createCloudflareBackofficeObjectRegistry } from "./cloudflare-durable-object-factory";
import { CloudflareDurableObjectFactory } from "./cloudflare-durable-object-factory";

const createNamespace = (options: { initialized?: boolean } = {}) => {
  const namespace = {
    idFromName: vi.fn((name: string) => `id:${name}`),
    get: vi.fn((id: string) =>
      options.initialized ? { id, init: vi.fn(() => ({ id })) } : { id },
    ),
  };
  return namespace;
};

describe("createCloudflareBackofficeObjectRegistry", () => {
  it("routes org-scoped objects through Cloudflare namespaces", async () => {
    const automations = createNamespace({ initialized: true });
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
      SANDBOX: createNamespace(),
    } as unknown as CloudflareEnv;

    const objects = createCloudflareBackofficeObjectRegistry(env);
    void objects.automations.forOrg("org-1");

    expect(automations.idFromName).toHaveBeenCalledWith("v1:org:org-1");
    expect(automations.get).toHaveBeenCalledWith("id:v1:org:org-1");
  });

  it("routes user and project scoped objects through the same canonical encoder", () => {
    const upload = createNamespace();
    const env = {
      AUTH: createNamespace(),
      AUTOMATIONS: createNamespace(),
      TELEGRAM: createNamespace(),
      OTP: createNamespace(),
      PI: createNamespace(),
      RESEND: createNamespace(),
      RESON8: createNamespace(),
      MCP: createNamespace(),
      UPLOAD: upload,
      GITHUB: createNamespace(),
      CLOUDFLARE_WORKERS: createNamespace(),
      GITHUB_WEBHOOK_ROUTER: createNamespace(),
      SANDBOX: createNamespace(),
    } as unknown as CloudflareEnv;

    const objects = createCloudflareBackofficeObjectRegistry(env);
    objects.upload.forUser({ userId: "user-1" });
    objects.upload.forProject({ orgId: "org-1", projectId: "project-1" });

    expect(upload.idFromName).toHaveBeenNthCalledWith(1, "v1:user:user-1");
    expect(upload.idFromName).toHaveBeenNthCalledWith(2, "v1:project:org-1:project-1");
  });

  it("rejects addresses for a different binding", () => {
    const env = {
      PI: createNamespace(),
    } as unknown as CloudflareEnv;
    const factory = new CloudflareDurableObjectFactory(env);

    expect(() =>
      factory.get(
        { name: "PI" },
        {
          binding: "AUTH",
          scope: { kind: "singleton" },
        },
      ),
    ).toThrow("does not match requested binding PI");
  });
});
