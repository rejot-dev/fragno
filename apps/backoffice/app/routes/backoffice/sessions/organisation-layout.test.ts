import { assert, describe, test } from "vitest";

import { isPiSessionsPath } from "./path";

describe("isPiSessionsPath", () => {
  const scope = { kind: "project" as const, orgId: "org-1", projectId: "project-1" };

  test.each([
    "/backoffice/sessions/project/org-1%3Aproject-1/sessions",
    "/backoffice/sessions/project/org-1%3Aproject-1/sessions/pi/session-1",
    "/backoffice/sessions/project/org-1%3Aproject-1/sessions/pi/session-1/debug",
    // React Router reports matched pathnames decoded, so the scope separator
    // arrives as a literal colon at runtime.
    "/backoffice/sessions/project/org-1:project-1/sessions",
    "/backoffice/sessions/project/org-1:project-1/sessions/pi/session-1",
    "/backoffice/sessions/project/org-1:project-1/sessions/pi/session-1/debug",
  ])("keeps the complete sessions branch in the workspace layout: %s", (pathname) => {
    assert(isPiSessionsPath(scope, pathname));
  });

  test.each([
    "/backoffice/sessions/project/org-1%3Aproject-1",
    "/backoffice/sessions/project/org-1:project-1",
  ])("does not apply the workspace layout outside the sessions branch: %s", (pathname) => {
    assert(!isPiSessionsPath(scope, pathname));
  });

  // Scope ids with reserved characters stay encoded inside the once-decoded
  // pathname; decoding again would corrupt them.
  const colonScope = { kind: "project" as const, orgId: "org-1", projectId: "a:b" };
  const slashScope = { kind: "project" as const, orgId: "org-1", projectId: "a/b" };

  test.each([
    [colonScope, "/backoffice/sessions/project/org-1%3Aa%253Ab/sessions/pi/session-1"],
    [colonScope, "/backoffice/sessions/project/org-1:a%3Ab/sessions/pi/session-1"],
    [slashScope, "/backoffice/sessions/project/org-1%3Aa%252Fb/sessions/pi/session-1"],
    [slashScope, "/backoffice/sessions/project/org-1:a%2Fb/sessions/pi/session-1"],
  ])("matches scope ids containing encoded characters: %o %s", (encodedScope, pathname) => {
    assert(isPiSessionsPath(encodedScope, pathname));
  });
});
