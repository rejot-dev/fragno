import { assert, describe, it } from "vitest";

import { describeUploadCollectionSource } from "./browser-database";

describe("Upload collection source", () => {
  it("scopes persisted metadata to the complete Backoffice scope", () => {
    const description = describeUploadCollectionSource({
      scope: { kind: "project", orgId: "org:with/slash", projectId: "project/one" },
      adapterIdentity: "adapter-1",
    });
    const internalUrl = new URL(description.internalUrl, "https://example.com");

    assert.equal(
      internalUrl.pathname,
      "/api/upload-scoped/project/org%253Awith%252Fslash%3Aproject%252Fone/_internal",
    );
    assert.equal(internalUrl.search, "");
    assert.equal(
      description.collectionId("file"),
      JSON.stringify([
        "backoffice",
        "upload",
        "project:org%3Awith%2Fslash:project%2Fone",
        "adapter-1",
        "file",
      ]),
    );
  });

  it("isolates persisted metadata when the adapter identity changes", () => {
    const scope = { kind: "org" as const, orgId: "org-1" };
    const first = describeUploadCollectionSource({ scope, adapterIdentity: "adapter-1" });
    const second = describeUploadCollectionSource({ scope, adapterIdentity: "adapter-2" });

    assert.notEqual(first.resourceKey, second.resourceKey);
    assert.notEqual(first.collectionId("file"), second.collectionId("file"));
  });
});
