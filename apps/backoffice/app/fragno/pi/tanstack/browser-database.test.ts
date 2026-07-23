import { assert, describe, it } from "vitest";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";

import { describePiCollectionSource, type PiCollectionSource } from "./browser-database";

const source = (
  scope: BackofficeContextScope,
  adapterIdentity = "adapter-1",
): PiCollectionSource => ({ scope, adapterIdentity });

const organisationSource = (orgId: string, adapterIdentity = "adapter-1") =>
  source({ kind: "org", orgId }, adapterIdentity);

describe("Pi collection source", () => {
  it("derives its internal route and collection ids from the canonical scope", () => {
    const description = describePiCollectionSource(organisationSource("org:with/slash"));

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
    const left = describePiCollectionSource(organisationSource("a.b", "c"));
    const right = describePiCollectionSource(organisationSource("a", "b.c"));

    assert.notEqual(left.resourceKey, right.resourceKey);
    assert.notEqual(
      left.collectionId("pi-harness.session"),
      right.collectionId("pi-harness.session"),
    );
  });
});
