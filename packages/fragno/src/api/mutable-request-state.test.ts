import { assert, describe, expect, test } from "vitest";

import { MutableRequestState } from "./mutable-request-state";

const createRequestState = (body: unknown) =>
  new MutableRequestState({
    pathParams: {},
    searchParams: new URLSearchParams(),
    body,
    headers: new Headers(),
  });

describe("MutableRequestState", () => {
  test("tracks an explicit undefined body override", () => {
    const state = createRequestState({ original: true });

    state.setBody(undefined);

    assert(state.hasBodyOverride);
    expect(state.body).toBeUndefined();
  });

  test("tracks an explicit null body override", () => {
    const state = createRequestState({ original: true });

    state.setBody(null);

    assert(state.hasBodyOverride);
    expect(state.body).toBeNull();
  });
});
