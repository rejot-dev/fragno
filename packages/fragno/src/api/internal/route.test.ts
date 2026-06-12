import { test, assert } from "vitest";

import { getMountRoute } from "./route";

test("getMountRoute - default mount route", () => {
  assert(getMountRoute({ name: "test" }) === "/api/test");
});

test("getMountRoute - custom mount route without trailing slash", () => {
  assert(getMountRoute({ name: "test", mountRoute: "/custom/path" }) === "/custom/path");
});

test("getMountRoute - custom mount route with trailing slash", () => {
  assert(getMountRoute({ name: "test", mountRoute: "/custom/path/" }) === "/custom/path");
});

test("getMountRoute - multiple trailing slashes", () => {
  assert(getMountRoute({ name: "test", mountRoute: "/custom/path///" }) === "/custom/path//");
});

test("getMountRoute - root path", () => {
  assert(getMountRoute({ name: "test", mountRoute: "/" }) === "");
});

test("getMountRoute - empty name", () => {
  assert(getMountRoute({ name: "" }) === "/api");
});

test("getMountRoute - name with special characters", () => {
  assert(getMountRoute({ name: "test-api_v1" }) === "/api/test-api_v1");
});

test("getMountRoute - name with spaces", () => {
  assert(getMountRoute({ name: "test api" }) === "/api/test api");
});

test("getMountRoute - custom mount route with query parameters", () => {
  assert(
    getMountRoute({ name: "test", mountRoute: "/api/v1?version=latest" }) ===
      "/api/v1?version=latest",
  );
});

test("getMountRoute - custom mount route with fragment", () => {
  assert(getMountRoute({ name: "test", mountRoute: "/api/v1#section" }) === "/api/v1#section");
});

test("getMountRoute - deeply nested path", () => {
  assert(
    getMountRoute({ name: "deeply-nested", mountRoute: "/api/v1/users/profile/settings" }) ===
      "/api/v1/users/profile/settings",
  );
});

test("getMountRoute - deeply nested path with trailing slash", () => {
  assert(
    getMountRoute({ name: "deeply-nested", mountRoute: "/api/v1/users/profile/settings/" }) ===
      "/api/v1/users/profile/settings",
  );
});
