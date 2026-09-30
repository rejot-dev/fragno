import { expect, test } from "vitest";

import { createCloudflareSandboxPhysicalId } from "./cloudflare-sandbox-id";

test("derives a stable bridge-compatible physical ID", async () => {
  await expect(createCloudflareSandboxPhysicalId("manager-1", "sandbox-1")).resolves.toBe(
    "zkggc5vrdcn4peogwvjs7wulbwkpihn6guvsgvhmceu2k5g7qrca",
  );
});
