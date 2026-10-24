import { assert, describe, it } from "vitest";

import { describeUploadReplicaSource } from "./replica";

describe("Upload replica source", () => {
  it("scopes the Fragno base URL to the complete Backoffice scope", () => {
    const description = describeUploadReplicaSource({
      scope: {
        kind: "project",
        owner: { kind: "org", orgId: "org:with/slash" },
        projectId: "project/one",
      },
      adapterIdentity: "adapter-1",
    });
    const baseUrl = new URL(description.baseUrl, "https://example.com");

    assert.equal(
      baseUrl.pathname,
      "/api/upload-scoped/project/org:org%253Awith%252Fslash:project%252Fone",
    );
    assert.equal(baseUrl.search, "");
  });

  it("opens a new replica when the adapter identity changes", () => {
    const scope = { kind: "org" as const, orgId: "org-1" };
    const first = describeUploadReplicaSource({ scope, adapterIdentity: "adapter-1" });
    const second = describeUploadReplicaSource({ scope, adapterIdentity: "adapter-2" });

    assert.notEqual(first.resourceKey, second.resourceKey);
    assert.equal(first.baseUrl, second.baseUrl);
  });
});
