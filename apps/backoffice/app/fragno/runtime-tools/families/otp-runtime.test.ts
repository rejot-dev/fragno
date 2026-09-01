import { describe, expect, test, vi } from "vitest";

import { unavailableBackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import { BackofficeKernel, noopBackofficeKernelObserver } from "@/backoffice-runtime/kernel";
import type { OtpObject } from "@/backoffice-runtime/object-registry";

import { createOtpRuntime } from "./otp-runtime";

const externalExecution = {
  scope: { kind: "org", orgId: "org-1" } as const,
  actors: {
    initiator: {
      scope: "external" as const,
      source: "telegram",
      type: "chat",
      id: "chat-123",
      role: "initiator" as const,
    },
    principal: null,
    delegation: [],
  },
};

const kernel = new BackofficeKernel({
  authorityResolver: unavailableBackofficeAuthorityResolver,
  kernelObserver: noopBackofficeKernelObserver,
});

describe("createOtpRuntime", () => {
  test("derives identity claims from the trusted external initiator", async () => {
    const issueIdentityClaim = vi.fn(async () => ({
      ok: true as const,
      otpId: "otp-1",
      externalId: "chat-123",
      code: "123456",
      type: "identity",
    }));
    const runtime = createOtpRuntime({
      object: { issueIdentityClaim } as unknown as OtpObject,
      config: {
        docsPublicBaseUrl: "https://backoffice.example",
        authEmailVerification: { enabled: false },
        signUpInvitationsEnabled: true,
        bindings: {
          api: false,
          auth: false,
          automations: false,
          billing: false,
          marketplace: false,
          telegram: false,
          otp: true,
          resend: false,
          reson8: false,
          mcp: false,
          upload: false,
          github: false,
          githubWebhookRouter: false,
          cloudflare: false,
          sandbox: false,
        },
      },
      scope: { kind: "org", organization: { id: "org-1", slug: "acme" } },
      kernel,
      execution: externalExecution,
    });

    await expect(runtime.createClaim({ ttlMinutes: 15 })).resolves.toMatchObject({
      url: "https://backoffice.example/backoffice/automations/acme/claims/complete?externalId=chat-123&code=123456",
      otpId: "otp-1",
      actor: { scope: "external", source: "telegram", type: "chat", id: "chat-123" },
    });
    expect(issueIdentityClaim).toHaveBeenCalledWith({
      scope: { kind: "org", orgId: "org-1" },
      actor: { scope: "external", source: "telegram", type: "chat", id: "chat-123" },
      expiresInMinutes: 15,
    });
  });

  test("rejects claims without a trusted external initiator", async () => {
    const issueIdentityClaim = vi.fn();
    const runtime = createOtpRuntime({
      object: { issueIdentityClaim } as unknown as OtpObject,
      config: {
        docsPublicBaseUrl: "https://backoffice.example",
        authEmailVerification: { enabled: false },
        signUpInvitationsEnabled: true,
        bindings: {
          api: false,
          auth: false,
          automations: false,
          billing: false,
          marketplace: false,
          telegram: false,
          otp: true,
          resend: false,
          reson8: false,
          mcp: false,
          upload: false,
          github: false,
          githubWebhookRouter: false,
          cloudflare: false,
          sandbox: false,
        },
      },
      scope: { kind: "org", organization: { id: "org-1", slug: "acme" } },
      kernel,
      execution: {
        scope: { kind: "org", orgId: "org-1" },
        actors: {
          initiator: { scope: "internal", type: "user", id: "user-1", role: "initiator" },
          principal: null,
          delegation: [],
        },
      },
    });

    await expect(runtime.createClaim({})).rejects.toThrow("trusted external automation initiator");
    expect(issueIdentityClaim).not.toHaveBeenCalled();
  });
});
