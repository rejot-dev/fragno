import { assert, describe, test } from "vitest";

import { isPiSessionsPath } from "./organisation-layout";

describe("isPiSessionsPath", () => {
  const scope = { kind: "project" as const, orgId: "org-1", projectId: "project-1" };

  test.each([
    "/backoffice/sessions/project/org-1%3Aproject-1/sessions",
    "/backoffice/sessions/project/org-1%3Aproject-1/sessions/pi/session-1",
    "/backoffice/sessions/project/org-1%3Aproject-1/sessions/pi/session-1/debug",
  ])("keeps the complete sessions branch in the workspace layout: %s", (pathname) => {
    assert(isPiSessionsPath(scope, pathname));
  });

  test("does not apply the workspace layout outside the sessions branch", () => {
    assert(!isPiSessionsPath(scope, "/backoffice/sessions/project/org-1%3Aproject-1"));
  });
});
