import { describe, test, assert } from "vitest";

import { filesDownloadPath, filesExplorerPath, filesScopeBasePath } from "./scope";

describe("Files scope paths", () => {
  test("encodes project scopes and explorer paths canonically", () => {
    const scope = {
      kind: "project" as const,
      organization: { id: "org-id", slug: "org/one" },
      projectId: "project:one",
      label: "Project one",
    };

    assert(filesScopeBasePath(scope) === "/backoffice/files/project/org%252Fone%3Aproject%253Aone");
    assert(
      filesExplorerPath(scope, "/workspace/notes/launch plan.md") ===
        "/backoffice/files/project/org%252Fone%3Aproject%253Aone/workspace/notes/launch%20plan.md",
    );
    assert(
      filesDownloadPath(scope, "/static/SYSTEM.md") ===
        "/backoffice/files/project/org%252Fone%3Aproject%253Aone/download?path=%2Fstatic%2FSYSTEM.md",
    );
  });

  test("preserves percent signs through router and scope decoding", () => {
    assert(
      filesScopeBasePath({
        kind: "org",
        organization: { id: "org-id", slug: "org%one" },
        label: "Percent org",
      }) === "/backoffice/files/org/org%2525one",
    );
  });

  test("supports system and personal scopes", () => {
    assert(
      filesScopeBasePath({ kind: "system", label: "System" }) === "/backoffice/files/system/system",
    );
    assert(
      filesScopeBasePath({ kind: "user", userId: "user/one", label: "user@example.com" }) ===
        "/backoffice/files/user/user%252Fone",
    );
  });
});
