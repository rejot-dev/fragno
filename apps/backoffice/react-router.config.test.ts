import { assert, test } from "vitest";

import reactRouterConfig from "./react-router.config";

test("includes every route in the initial browser manifest", () => {
  assert.deepEqual(reactRouterConfig.routeDiscovery, { mode: "initial" });
});
