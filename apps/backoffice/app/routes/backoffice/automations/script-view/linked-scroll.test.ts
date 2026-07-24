import { assert, describe, it } from "vitest";

import { proportionalScrollTop } from "./linked-scroll";

describe("proportionalScrollTop", () => {
  it("maps the source scroll progress onto the target viewport", () => {
    assert.equal(
      proportionalScrollTop(
        { scrollTop: 300, scrollHeight: 1_000, clientHeight: 400 },
        { scrollHeight: 2_000, clientHeight: 500 },
      ),
      750,
    );
  });

  it("clamps overscroll to the target boundaries", () => {
    assert.equal(
      proportionalScrollTop(
        { scrollTop: 900, scrollHeight: 1_000, clientHeight: 400 },
        { scrollHeight: 2_000, clientHeight: 500 },
      ),
      1_500,
    );
  });

  it("keeps the target at the top when either viewport does not scroll", () => {
    assert.equal(
      proportionalScrollTop(
        { scrollTop: 0, scrollHeight: 400, clientHeight: 400 },
        { scrollHeight: 2_000, clientHeight: 500 },
      ),
      0,
    );
    assert.equal(
      proportionalScrollTop(
        { scrollTop: 300, scrollHeight: 1_000, clientHeight: 400 },
        { scrollHeight: 500, clientHeight: 500 },
      ),
      0,
    );
  });
});
