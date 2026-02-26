import { describe, expect, it } from "vitest";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { createPiFragmentClients } from "./clients";
import { createPiFragmentClient as createVanillaClient } from "../client/vanilla";
import { createPiFragmentClient as createReactClient } from "../client/react";
import { createPiFragmentClient as createSolidClient } from "../client/solid";
import { createPiFragmentClient as createSvelteClient } from "../client/svelte";
import { createPiFragmentClient as createVueClient } from "../client/vue";

const clientConfig: FragnoPublicClientConfig = {
  baseUrl: "http://localhost:3000",
};

const expectedKeys = ["useSessions", "useSession", "useCreateSession", "useSendMessage"] as const;

describe("pi-fragment client exports", () => {
  it("exposes hooks and mutators for pi routes", () => {
    const clients = createPiFragmentClients(clientConfig);

    expect(clients.useSessions.route.path).toBe("/sessions");
    expect(clients.useSessions.route.method).toBe("GET");
    expect(typeof clients.useSessions.store).toBe("function");

    expect(clients.useSession.route.path).toBe("/sessions/:sessionId");
    expect(clients.useSession.route.method).toBe("GET");
    expect(typeof clients.useSession.store).toBe("function");

    expect(clients.useCreateSession.route.path).toBe("/sessions");
    expect(clients.useCreateSession.route.method).toBe("POST");
    expect(typeof clients.useCreateSession.mutateQuery).toBe("function");
    expect(clients.useCreateSession.mutatorStore).toBeDefined();

    expect(clients.useSendMessage.route.path).toBe("/sessions/:sessionId/messages");
    expect(clients.useSendMessage.route.method).toBe("POST");
    expect(typeof clients.useSendMessage.mutateQuery).toBe("function");
    expect(clients.useSendMessage.mutatorStore).toBeDefined();
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
