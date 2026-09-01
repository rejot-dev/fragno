import { afterEach, assert, describe, expect, it, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {},
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { RouterContextProvider } from "react-router";

import {
  createInMemoryBackofficeRuntime,
  type InMemoryBackofficeRuntime,
} from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { bytesToHex } from "@/lib/crypto";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { action } from "./github-webhooks";

const WEBHOOK_SECRET = "github-webhook-route-test-secret";
const INSTALLATION_ID = "12345";
const ORG_ID = "org-1";
const runtimes: InMemoryBackofficeRuntime[] = [];

class RecordingGitHubObject {
  readonly configuredOrgIds: string[] = [];
  readonly requests: Request[] = [];

  async ensureAdminConfig(orgId: string) {
    this.configuredOrgIds.push(orgId);
    return { configured: true };
  }

  async fetch(request: Request) {
    this.requests.push(new Request(request));
    return new Response(null, { status: 202 });
  }
}

function createRouteContext(runtime: InMemoryBackofficeRuntime) {
  const context = new RouterContextProvider();
  context.set(BackofficeWorkerContext, {
    runtime: runtime.services,
    kernel: new BackofficeKernel(runtime.services),
    env: {
      BACKOFFICE_INTERNAL_REQUEST_SECRET: runtime.env.BACKOFFICE_INTERNAL_REQUEST_SECRET,
    } as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
  return context;
}

async function signWebhookBody(body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `sha256=${bytesToHex(new Uint8Array(signature))}`;
}

async function createWebhookRequest({ validSignature = true }: { validSignature?: boolean } = {}) {
  const body = JSON.stringify({ installation: { id: INSTALLATION_ID }, action: "created" });
  return {
    body,
    request: new Request("https://backoffice.example/api/github/webhooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "installation",
        "x-hub-signature-256": validSignature ? await signWebhookBody(body) : "sha256=invalid",
      },
      body,
    }),
  };
}

function callAction(request: Request, runtime: InMemoryBackofficeRuntime) {
  return action({
    request,
    url: new URL(request.url),
    context: createRouteContext(runtime),
    params: {},
  } as unknown as Parameters<typeof action>[0]);
}

async function createRuntime(githubObject: RecordingGitHubObject) {
  const runtime = await createInMemoryBackofficeRuntime({
    env: { GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET },
    objectFactories: { GITHUB: () => githubObject },
  });
  runtimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.cleanup()));
});

describe("GitHub webhook route", () => {
  it("rejects invalid signatures inside the webhook router object", async () => {
    const githubObject = new RecordingGitHubObject();
    const runtime = await createRuntime(githubObject);
    const { request } = await createWebhookRequest({ validSignature: false });

    const response = await callAction(request, runtime);

    assert(response.status === 401);
    expect(githubObject.requests).toHaveLength(0);
  });

  it("rejects installations without an organization mapping", async () => {
    const githubObject = new RecordingGitHubObject();
    const runtime = await createRuntime(githubObject);
    const { request } = await createWebhookRequest();

    const response = await callAction(request, runtime);

    assert(response.status === 404);
    expect(githubObject.requests).toHaveLength(0);
  });

  it("verifies and routes the untouched webhook from the object host", async () => {
    const githubObject = new RecordingGitHubObject();
    const runtime = await createRuntime(githubObject);
    await runtime.objects.githubWebhookRouter
      .singleton()
      .commands.setInstallationOrg(INSTALLATION_ID, ORG_ID);
    const { body, request } = await createWebhookRequest();

    const response = await callAction(request, runtime);

    assert(response.status === 202);
    expect(githubObject.configuredOrgIds).toEqual([ORG_ID]);
    expect(githubObject.requests).toHaveLength(1);
    const forwardedRequest = githubObject.requests[0];
    const forwardedUrl = new URL(forwardedRequest.url);
    assert(forwardedUrl.pathname === "/api/github/webhooks");
    assert(forwardedUrl.searchParams.get("orgId") === ORG_ID);
    assert(forwardedRequest.headers.get("x-github-delivery") === "delivery-1");
    assert((await forwardedRequest.text()) === body);
  });
});
