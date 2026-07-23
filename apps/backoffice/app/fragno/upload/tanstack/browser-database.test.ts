import { assert, describe, it } from "vitest";

import { describeUploadCollectionSource } from "./browser-database";

describe("Upload collection source", () => {
  it("scopes the persisted file metadata collection to the organisation", () => {
    const description = describeUploadCollectionSource({
      orgId: "org:with/slash",
      adapterIdentity: "adapter-1",
    });
    const internalUrl = new URL(description.internalUrl, "https://example.com");

    assert.equal(internalUrl.pathname, "/api/upload/org%3Awith%2Fslash/_internal");
    assert.equal(internalUrl.search, "");
    assert.equal(
      description.collectionId("file"),
      JSON.stringify(["backoffice", "upload", "org:with/slash", "adapter-1", "file"]),
    );
  });

  it("isolates persisted metadata when the adapter identity changes", () => {
    const first = describeUploadCollectionSource({ orgId: "org-1", adapterIdentity: "adapter-1" });
    const second = describeUploadCollectionSource({ orgId: "org-1", adapterIdentity: "adapter-2" });

    assert.notEqual(first.resourceKey, second.resourceKey);
    assert.notEqual(first.collectionId("file"), second.collectionId("file"));
  });
});
