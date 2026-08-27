import { describe, expect, test } from "vitest";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";

import { createCodemodeStaticArtifactsResolver } from "./static-codemode-artifacts";

describe("createCodemodeStaticArtifactsResolver", () => {
  test("does not resolve organization-specific MCP declarations for user scope", async () => {
    const resolveArtifacts = createCodemodeStaticArtifactsResolver({
      objects: {} as BackofficeObjectRegistry,
      config: {} as BackofficeRuntimeConfig,
      execution: createBackofficeUserExecution({
        scope: { kind: "user", userId: "user-1" },
        userId: "user-1",
      }),
    });

    await expect(resolveArtifacts()).resolves.toEqual({});
  });
});
