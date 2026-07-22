import { describe, expect, test } from "vitest";

import { scopedPublicMountPath } from "./scoped-public-fragment-routes";

describe("scoped public fragment routes", () => {
  test.each([
    [{ kind: "system" as const }, "/api/pi/system"],
    [{ kind: "org" as const, orgId: "org:one" }, "/api/pi/org%3Aorg%253Aone"],
    [{ kind: "user" as const, userId: "user/one" }, "/api/pi/user%3Auser%252Fone"],
    [
      { kind: "project" as const, orgId: "org:one", projectId: "project/two" },
      "/api/pi/project%3Aorg%253Aone%3Aproject%252Ftwo",
    ],
  ])("builds a mount path for the %s scope", (scope, expected) => {
    expect(scopedPublicMountPath({ publicPrefix: "/api/pi", scope })).toBe(expected);
  });
});
