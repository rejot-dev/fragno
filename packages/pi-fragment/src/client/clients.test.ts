import { describe, expect, it, assert } from "vitest";

import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { createPiFragmentClients } from "./clients";
import { createPiFragmentClient as createReactClient } from "./react";
import { createPiFragmentClient as createSolidClient } from "./solid";
import { createPiFragmentClient as createSvelteClient } from "./svelte";
import { createPiFragmentClient as createVanillaClient } from "./vanilla";
import { createPiFragmentClient as createVueClient } from "./vue";

const clientConfig: FragnoPublicClientConfig = {
  baseUrl: "http://localhost:3000",
};

const expectedKeys = [
  "useSessions",
  "useSessionDetail",
  "useCreateSession",
  "useSessionEvents",
  "useCommandSession",
] as const;

describe("pi-fragment client exports", () => {
  it("exposes hooks and mutators for pi routes", () => {
    const clients = createPiFragmentClients(clientConfig);

    assert(clients.useSessions.route.path === "/workflows/:workflowName/sessions");
    assert(clients.useSessions.route.method === "GET");
    assert(typeof clients.useSessions.store === "function");

    assert(clients.useSessionDetail.route.path === "/workflows/:workflowName/sessions/:sessionId");
    assert(clients.useSessionDetail.route.method === "GET");
    assert(typeof clients.useSessionDetail.store === "function");

    assert(clients.useCreateSession.route.path === "/workflows/:workflowName/sessions");
    assert(clients.useCreateSession.route.method === "POST");
    assert(typeof clients.useCreateSession.mutateQuery === "function");
    expect(clients.useCreateSession.mutatorStore).toBeDefined();

    assert(
      clients.useSessionEvents.route.path === "/workflows/:workflowName/sessions/:sessionId/events",
    );
    assert(clients.useSessionEvents.route.method === "GET");
    assert(typeof clients.useSessionEvents.store === "function");

    assert(
      clients.useCommandSession.route.path ===
        "/workflows/:workflowName/sessions/:sessionId/command",
    );
    assert(clients.useCommandSession.route.method === "POST");
    assert(typeof clients.useCommandSession.mutateQuery === "function");
    expect(clients.useCommandSession.mutatorStore).toBeDefined();
  });

  it("creates vanilla client factory without throwing", () => {
    const clients = createVanillaClient(clientConfig);

    for (const key of expectedKeys) {
      expect(clients).toHaveProperty(key);
    }
  });

  it("creates framework client factories without throwing", () => {
    const factories = {
      react: createReactClient,
      solid: createSolidClient,
      svelte: createSvelteClient,
      vue: createVueClient,
    };

    for (const factory of Object.values(factories)) {
      let clients: Record<string, unknown> | undefined;
      expect(() => {
        clients = factory(clientConfig) as Record<string, unknown>;
      }).not.toThrow();
      if (!clients) {
        throw new Error("Expected client factory to return clients.");
      }

      for (const key of expectedKeys) {
        assert(typeof clients[key] === "function");
      }
    }
  });
});
