import { describe, expect, test } from "vitest";

import { extractW3CRequestPropagationContext } from "./request-propagation-context";

describe("extractW3CRequestPropagationContext", () => {
  test("extracts only traceparent and optional tracestate", () => {
    expect(
      extractW3CRequestPropagationContext(
        new Headers({
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01",
          tracestate: "vendor=value",
          baggage: "private=value",
          authorization: "Bearer secret",
        }),
      ),
    ).toEqual({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01",
      tracestate: "vendor=value",
    });
  });

  test("returns null without traceparent", () => {
    expect(
      extractW3CRequestPropagationContext(new Headers({ tracestate: "vendor=value" })),
    ).toBeNull();
  });
});
