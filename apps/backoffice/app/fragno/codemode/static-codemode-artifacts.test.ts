import { describe, expect, test } from "vitest";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";

import { createCodemodeStaticArtifactsResolver } from "./static-codemode-artifacts";

describe("createCodemodeStaticArtifactsResolver", () => {
  test("provides codemode declarations for user-scoped sessions", async () => {
    const resolveArtifacts = createCodemodeStaticArtifactsResolver({
      objects: {} as BackofficeObjectRegistry,
      config: {} as BackofficeRuntimeConfig,
      execution: createBackofficeUserExecution({
        scope: { kind: "user", userId: "user-1" },
        userId: "user-1",
      }),
      families: [],
    });

    await expect(resolveArtifacts()).resolves.toMatchObject({
      "codemode/system.d.ts": expect.any(String),
      "codemode/workflow-authoring.d.ts": expect.any(String),
    });
  });
});
