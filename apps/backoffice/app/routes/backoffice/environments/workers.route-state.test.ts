import { describe, expect, test } from "vitest";

import { readWorkersRouteState, toWorkersPath } from "./workers.route-state";

describe("workers.route-state", () => {
  test("builds a detail worker path", () => {
    expect(toWorkersPath({ workerId: "alpha" })).toBe(
      "/backoffice/environments/workers?worker=alpha",
    );
  });

  test("builds a new worker path", () => {
    expect(toWorkersPath({ view: "new" })).toBe("/backoffice/environments/workers?view=new");
  });

  test("parses a selected worker from the route", () => {
    expect(
      readWorkersRouteState({
        pathname: "/backoffice/environments/workers",
        search: "?worker=alpha",
      }),
    ).toEqual({
      view: "detail",
      workerId: "alpha",
    });
  });

  test("ignores worker selection when the route is in new view", () => {
    expect(
      readWorkersRouteState({
        pathname: "/backoffice/environments/workers",
        search: "?view=new&worker=alpha",
      }),
    ).toEqual({
      view: "new",
      workerId: null,
    });
  });

  test("accepts a trailing slash", () => {
    expect(
      readWorkersRouteState({
        pathname: "/backoffice/environments/workers/",
        search: "?worker=alpha",
      }),
    ).toEqual({
      view: "detail",
      workerId: "alpha",
    });
  });

  test("returns null for a different route", () => {
    expect(
      readWorkersRouteState({
        pathname: "/backoffice/environments/cf-sandbox",
        search: "?worker=alpha",
      }),
    ).toBeNull();
  });
});
