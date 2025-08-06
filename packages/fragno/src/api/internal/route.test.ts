import { test, expect } from "vitest";
import { getMountRoute } from "./route";

test("getMountRoute - default mount route", () => {
  expect(getMountRoute({ name: "test" })).toBe("/api/test");
});

test("getMountRoute - custom mount route without trailing slash", () => {
  expect(getMountRoute({ name: "test", mountRoute: "/custom/path" })).toBe("/custom/path");
});

test("getMountRoute - custom mount route with trailing slash", () => {
  expect(getMountRoute({ name: "test", mountRoute: "/custom/path/" })).toBe("/custom/path");
});

test("getMountRoute - multiple trailing slashes", () => {
  expect(getMountRoute({ name: "test", mountRoute: "/custom/path///" })).toBe("/custom/path//");
});

test("getMountRoute - root path", () => {
  expect(getMountRoute({ name: "test", mountRoute: "/" })).toBe("");
});

test("getMountRoute - empty name", () => {
  expect(getMountRoute({ name: "" })).toBe("/api");
});

test("getMountRoute - name with special characters", () => {
  expect(getMountRoute({ name: "test-api_v1" })).toBe("/api/test-api_v1");
});

test("getMountRoute - name with spaces", () => {
  expect(getMountRoute({ name: "test api" })).toBe("/api/test api");
});

test("getMountRoute - custom mount route with query parameters", () => {
  expect(getMountRoute({ name: "test", mountRoute: "/api/v1?version=latest" })).toBe(
    "/api/v1?version=latest",
  );
});

test("getMountRoute - custom mount route with fragment", () => {
  expect(getMountRoute({ name: "test", mountRoute: "/api/v1#section" })).toBe("/api/v1#section");
});

test("getMountRoute - deeply nested path", () => {
  expect(
    getMountRoute({ name: "deeply-nested", mountRoute: "/api/v1/users/profile/settings" }),
  ).toBe("/api/v1/users/profile/settings");
});

test("getMountRoute - deeply nested path with trailing slash", () => {
  expect(
    getMountRoute({ name: "deeply-nested", mountRoute: "/api/v1/users/profile/settings/" }),
  ).toBe("/api/v1/users/profile/settings");
});
