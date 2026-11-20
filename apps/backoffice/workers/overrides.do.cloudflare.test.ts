import { expect, test } from "vitest";

import { env } from "cloudflare:workers";

import { createCloudflareBackofficeObjectRegistry } from "@/backoffice-runtime/cloudflare-durable-object-factory";

test("a new root owner's object migrates its SQLite storage before keeping overrides", async () => {
  const { overrides } = createCloudflareBackofficeObjectRegistry(env);
  const organization = { kind: "org", orgId: "overrides-test", jurisdiction: null } as const;
  const project = { kind: "project", owner: organization, projectId: "website" } as const;
  const { commands } = overrides.for(organization);
  const address = { scope: project, kind: "feature-flag", key: "scope-probe" } as const;
  await commands.setOverride({ ...address, value: true });
  await expect(commands.listOverrides(project)).resolves.toEqual([
    {
      scope: "project:org:overrides-test:website",
      kind: "feature-flag",
      key: "scope-probe",
      value: true,
    },
  ]);
});
