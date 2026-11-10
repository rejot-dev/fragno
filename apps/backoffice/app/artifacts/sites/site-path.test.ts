import { assert, test } from "vitest";

import { sitePathProblem } from "./site-path";

test("a site's path cannot lead to the paths its host keeps for itself", () => {
  assert.equal(
    sitePathProblem("/workspace/__ley/shop.site"),
    "/workspace/__ley/shop.site is inside /workspace/__ley, whose address sites cannot use.",
  );
  assert.isNull(sitePathProblem("/workspace/__ley.site"));
  assert.isNull(sitePathProblem("/workspace/docs/__ley/shop.site"));
});
