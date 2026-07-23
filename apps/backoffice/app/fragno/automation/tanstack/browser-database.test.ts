import { assert, describe, test } from "vitest";

import { describeAutomationCollectionSource } from "./browser-database";

describe("Automation collection sources", () => {
  test("describes an organization-scoped outbox and stable collection ids", () => {
    const description = describeAutomationCollectionSource({
      scope: { kind: "org", orgId: "org-1" },
      adapterIdentity: "adapter-1",
    });

    assert(description.internalUrl === "/api/automations-scoped/org/org-1/_internal");
    assert(
      description.collectionId("automation_event") ===
        JSON.stringify(["backoffice", "automations", "org:org-1", "adapter-1", "automation_event"]),
    );
  });

  test("uses the encoded route id for project-scoped outboxes", () => {
    const description = describeAutomationCollectionSource({
      scope: {
        kind: "project",
        orgId: "org-1",
        projectId: "project/one",
      },
      adapterIdentity: "adapter-1",
    });

    assert(
      description.internalUrl ===
        "/api/automations-scoped/project/org-1%3Aproject%252Fone/_internal",
    );
  });

  test("isolates persisted data when the adapter identity changes", () => {
    const scope = { kind: "org", orgId: "org-1" } as const;
    const first = describeAutomationCollectionSource({ scope, adapterIdentity: "adapter-1" });
    const second = describeAutomationCollectionSource({ scope, adapterIdentity: "adapter-2" });

    assert.notEqual(first.resourceKey, second.resourceKey);
    assert.notEqual(
      first.collectionId("automation_event"),
      second.collectionId("automation_event"),
    );
  });
});
