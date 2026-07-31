import { describe, expect, test, vi } from "vitest";

import { executeBackofficeRuntimeTool } from "../runtime-tools";
import { automationIdentityRuntimeTools } from "./automations-identities";

describe("automation identity runtime tools", () => {
  test("resolve an external identity through workflow-owned logic", async () => {
    const [resolveExternalIdentity] = automationIdentityRuntimeTools;
    const resolveExternal = vi.fn(async () => ({ userId: "user-1" }));

    const result = await executeBackofficeRuntimeTool(
      resolveExternalIdentity,
      { source: "telegram", type: "chat", id: "1001" },
      {
        runtimes: { identity: { resolveExternal } },
      } as never,
    );

    expect(resolveExternal).toHaveBeenCalledWith({
      source: "telegram",
      type: "chat",
      id: "1001",
    });
    expect(result).toEqual({ userId: "user-1" });
  });

  test.each(["scope", "actor", "actors", "principal", "execution"])(
    "rejects caller-supplied %s metadata",
    (field) => {
      const [resolveExternalIdentity] = automationIdentityRuntimeTools;
      expect(() =>
        resolveExternalIdentity.inputSchema.parse({
          source: "telegram",
          type: "chat",
          id: "1001",
          [field]: {},
        }),
      ).toThrow();
    },
  );
});
