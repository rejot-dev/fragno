import { describe, test, assert } from "vitest";

import { filesDownloadPath, filesExplorerPath, filesScopeBasePath } from "./scope";

describe("Files scope paths", () => {
  test("encodes project scopes and explorer paths canonically", () => {
    const scope = {
      kind: "project" as const,
      owner: {
        kind: "org" as const,
        organization: { id: "org-id", slug: "org/one", jurisdiction: null },
      },
      project: { id: "project:one", slug: "project:one" },
      label: "Project one",
    };

    assert(
      filesScopeBasePath(scope) === "/backoffice/files/project/org:org%252Fone:project%253Aone",
    );
    assert(
      filesExplorerPath(scope, "/workspace/notes/launch plan.md") ===
        "/backoffice/files/project/org:org%252Fone:project%253Aone/workspace/notes/launch%20plan.md",
    );
    assert(
      filesDownloadPath(scope, "/static/SYSTEM.md", "attachment") ===
        "/backoffice/files/project/org:org%252Fone:project%253Aone/download?path=%2Fstatic%2FSYSTEM.md",
    );
    assert(
      filesDownloadPath(scope, "/static/logo.png", "inline") ===
        "/backoffice/files/project/org:org%252Fone:project%253Aone/download?path=%2Fstatic%2Flogo.png&disposition=inline",
    );
  });

  test("preserves percent signs through router and scope decoding", () => {
    assert(
      filesScopeBasePath({
        kind: "org",
        organization: { id: "org-id", slug: "org%one", jurisdiction: null },
      }) === "/backoffice/files/org/org%2525one",
    );
  });

  test("supports system and personal scopes", () => {
    assert(filesScopeBasePath({ kind: "system" }) === "/backoffice/files/system/system");
    assert(
      filesScopeBasePath({ kind: "user", userId: "user/one", jurisdiction: null }) ===
        "/backoffice/files/user/user%252Fone",
    );
  });
});
