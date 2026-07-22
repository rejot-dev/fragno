import { assert, describe, it } from "vitest";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";

import {
  createPiPersistenceResourceRegistry,
  describePiPersistenceSource,
  type PiPersistenceSource,
} from "./database";

const source = (
  scope: BackofficeContextScope,
  adapterIdentity = "adapter-1",
): PiPersistenceSource => ({ scope, adapterIdentity });

const organisationSource = (orgId: string, adapterIdentity = "adapter-1") =>
  source({ kind: "org", orgId }, adapterIdentity);

describe("Pi persistence source", () => {
  it("derives its internal route and collection ids from the canonical scope", () => {
    const description = describePiPersistenceSource(organisationSource("org:with/slash"));

    assert.equal(description.internalUrl, "/api/pi/org%3Aorg%253Awith%252Fslash/_internal");
    assert.equal(
      description.collectionId("workflows.workflow_step"),
      JSON.stringify([
        "backoffice",
        "pi",
        "org:org%3Awith%2Fslash",
        "adapter-1",
        "workflows.workflow_step",
      ]),
    );
  });

  it("does not collide when scope and adapter identity contain collection-id separators", () => {
    const left = describePiPersistenceSource(organisationSource("a.b", "c"));
    const right = describePiPersistenceSource(organisationSource("a", "b.c"));

    assert.notEqual(left.resourceKey, right.resourceKey);
    assert.notEqual(left.collectionId("session"), right.collectionId("session"));
  });
});

describe("Pi persistence resource registry", () => {
  it("reuses a resource for the same scope and adapter identity", () => {
    let created = 0;
    const registry = createPiPersistenceResourceRegistry(() => ({ id: ++created }));

    const first = registry.resourceFor(organisationSource("org-1"));
    const second = registry.resourceFor(organisationSource("org-1"));

    assert.equal(second, first);
    assert.equal(created, 1);
  });

  it("isolates resources by scope and adapter identity", () => {
    let created = 0;
    const registry = createPiPersistenceResourceRegistry(() => ({ id: ++created }));

    const original = registry.resourceFor(organisationSource("org-1", "adapter-1"));
    const project = registry.resourceFor(
      source({ kind: "project", orgId: "org-1", projectId: "project-1" }),
    );
    const user = registry.resourceFor(source({ kind: "user", userId: "user-1" }));
    const system = registry.resourceFor(source({ kind: "system" }));
    const replacedAdapter = registry.resourceFor(organisationSource("org-1", "adapter-2"));

    assert.notEqual(project, original);
    assert.notEqual(user, original);
    assert.notEqual(system, original);
    assert.notEqual(replacedAdapter, original);
    assert.equal(created, 5);
  });
});
