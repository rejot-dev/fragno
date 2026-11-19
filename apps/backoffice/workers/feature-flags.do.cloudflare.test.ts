import { expect, test } from "vitest";

import { env } from "cloudflare:workers";

import { createCloudflareBackofficeObjectRegistry } from "@/backoffice-runtime/cloudflare-durable-object-factory";

test("a new organization object migrates its SQLite storage before handling flag commands", async () => {
  const { featureFlags } = createCloudflareBackofficeObjectRegistry(env);
  const { commands } = featureFlags.for({
    kind: "org",
    orgId: "feature-flag-test",
    jurisdiction: null,
  });
  const key = "organization-access-summary";
  await expect(commands.setFlag({ key, override: false })).resolves.toMatchObject({
    defaultEnabled: true,
    override: false,
    enabled: false,
  });
  await expect(commands.getFlag(key)).resolves.toMatchObject({ override: false, enabled: false });
});
