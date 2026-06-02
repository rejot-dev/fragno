import { describe, expect, it } from "vitest";

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

    expect(clients.useSessions.route.path).toBe("/workflows/:workflowName/sessions");
    expect(clients.useSessions.route.method).toBe("GET");
    expect(typeof clients.useSessions.store).toBe("function");

    expect(clients.useSessionDetail.route.path).toBe(
      "/workflows/:workflowName/sessions/:sessionId",
    );
    expect(clients.useSessionDetail.route.method).toBe("GET");
    expect(typeof clients.useSessionDetail.store).toBe("function");

    expect(clients.useCreateSession.route.path).toBe("/workflows/:workflowName/sessions");
    expect(clients.useCreateSession.route.method).toBe("POST");
    expect(typeof clients.useCreateSession.mutateQuery).toBe("function");
    expect(clients.useCreateSession.mutatorStore).toBeDefined();

    expect(clients.useSessionEvents.route.path).toBe(
      "/workflows/:workflowName/sessions/:sessionId/events",
    );
    expect(clients.useSessionEvents.route.method).toBe("GET");
    expect(typeof clients.useSessionEvents.store).toBe("function");

    expect(clients.useCommandSession.route.path).toBe(
      "/workflows/:workflowName/sessions/:sessionId/command",
    );
    expect(clients.useCommandSession.route.method).toBe("POST");
    expect(typeof clients.useCommandSession.mutateQuery).toBe("function");
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
        expect(typeof clients[key]).toBe("function");
      }
    }
  });
});
