import { assert, describe, it } from "vitest";

import { describeUploadCollectionSource } from "./browser-database";

describe("Upload collection source", () => {
  it("scopes the Fragno base URL to the complete Backoffice scope", () => {
    const description = describeUploadCollectionSource({
      scope: { kind: "project", orgId: "org:with/slash", projectId: "project/one" },
      adapterIdentity: "adapter-1",
    });
    const baseUrl = new URL(description.baseUrl, "https://example.com");

    assert.equal(
      baseUrl.pathname,
      "/api/upload-scoped/project/org%253Awith%252Fslash%3Aproject%252Fone",
    );
    assert.equal(baseUrl.search, "");
  });

  it("isolates browser resources when the adapter identity changes", () => {
    const scope = { kind: "org" as const, orgId: "org-1" };
    const first = describeUploadCollectionSource({ scope, adapterIdentity: "adapter-1" });
    const second = describeUploadCollectionSource({ scope, adapterIdentity: "adapter-2" });

    assert.notEqual(first.resourceKey, second.resourceKey);
    assert.equal(first.baseUrl, second.baseUrl);
  });
});
