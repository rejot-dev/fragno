import { describe, expect, test } from "vitest";
import { buildPath, extractPathParams, matchPathParams } from "./path";

describe("extractPathParams (runtime names)", () => {
  test("no params", () => {
    expect(extractPathParams("/static/assets")).toEqual([]);
    expect(extractPathParams("/")).toEqual([]);
    expect(extractPathParams("")).toEqual([]);
  });

  test("named param", () => {
    expect(extractPathParams("/users/:id")).toEqual(["id"]);
    expect(extractPathParams(":id")).toEqual(["id"]);
    expect(extractPathParams("/:id")).toEqual(["id"]);
  });

  test("empty name param segment is allowed", () => {
    expect(extractPathParams("/:")).toEqual([""]);
    expect(extractPathParams("/:/x")).toEqual([""]);
  });

  test("duplicate identifiers are preserved in order", () => {
    expect(extractPathParams("/path/:/x/:/")).toEqual(["", ""]);
    expect(extractPathParams("/path/:var/x/:var")).toEqual(["var", "var"]);
  });

  test("multiple named params", () => {
    expect(extractPathParams("/users/:id/posts/:postId")).toEqual(["id", "postId"]);
  });

  test("wildcards", () => {
    expect(extractPathParams("/path/foo/**")).toEqual(["**"]);
    expect(extractPathParams("/path/foo/**:name")).toEqual(["name"]);
  });

  test("mixed complex", () => {
    expect(extractPathParams("/api/:version/users/:userId/posts/:postId/**:remaining")).toEqual([
      "version",
      "userId",
      "postId",
      "remaining",
    ]);
  });

  test("consecutive slashes are ignored in names extraction", () => {
    expect(extractPathParams("//path//:name")).toEqual(["name"]);
  });
});

describe("matchPathParams (runtime extraction)", () => {
  test("literal match with named param", () => {
    expect(matchPathParams("/users/:id", "/users/123")).toEqual({ id: "123" });
  });

  test("mismatch returns empty object", () => {
    expect(matchPathParams("/users/:id", "/posts/123")).toEqual({});
  });

  test("named wildcard captures remainder", () => {
    expect(matchPathParams("/files/**:rest", "/files/a/b/c")).toEqual({ rest: "a/b/c" });
    expect(matchPathParams("/files/**:rest", "/files")).toEqual({ rest: "" });
  });

  test("anonymous wildcard captures remainder under ** key", () => {
    expect(matchPathParams("/files/**", "/files/a/b")).toEqual({ "**": "a/b" });
    expect(matchPathParams("/files/**", "/files")).toEqual({ "**": "" });
  });

  test("mixed named segment and wildcard remainder", () => {
    expect(matchPathParams("/api/:version/**:rest", "/api/v1/users/1")).toEqual({
      version: "v1",
      rest: "users/1",
    });
  });

  test("trailing slashes are ignored", () => {
    expect(matchPathParams("/users/:id", "/users/123/")).toEqual({ id: "123" });
  });

  test("pattern longer than path fills empty strings for remaining params", () => {
    // Remaining ":id" becomes empty string
    expect(matchPathParams("/users/:id", "/users")).toEqual({ id: "" });
    // Remaining "**" becomes empty string
    expect(matchPathParams("/files/**", "/files")).toEqual({ "**": "" });
  });
});

describe("buildPath (runtime building)", () => {
  test("builds literal match with named param", () => {
    expect(buildPath("/users/:id", { id: "123" })).toEqual("/users/123");
  });

  test("encodes named params", () => {
    expect(buildPath("/q/:term", { term: "a b" })).toEqual("/q/a%20b");
    expect(buildPath("/:name", { name: "ä" })).toEqual("/%C3%A4");
  });

  test("builds with named wildcard remainder", () => {
    expect(buildPath("/files/**:rest", { rest: "a/b/c" })).toEqual("/files/a/b/c");
  });

  test("builds with anonymous wildcard remainder", () => {
    expect(buildPath("/files/**", { "**": "a/b" })).toEqual("/files/a/b");
  });

  test("preserves extra slashes from pattern", () => {
    expect(buildPath("//path//:name//", { name: "x" })).toEqual("//path//x//");
  });

  test("throws on missing named param", () => {
    // @ts-expect-error - intentionally passing missing param to test runtime error
    expect(() => buildPath("/users/:id", {})).toThrowError(/Missing value/);
  });

  test("throws on missing wildcard values", () => {
    // @ts-expect-error - intentionally passing missing param to test runtime error
    expect(() => buildPath("/files/**", {})).toThrowError(/Missing value/);
    // @ts-expect-error - intentionally passing missing param to test runtime error
    expect(() => buildPath("/files/**:rest", {})).toThrowError(/Missing value/);
  });
});
