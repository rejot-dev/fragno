import { afterEach, describe, expect, it, vi } from "vitest";

import { createId, init } from "./id";

const idPattern = /^[a-z][0-9a-z]*$/;

const createCounter = (start = 0) => {
  let value = start;
  return () => value++;
};

describe("db id", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("re-exports the shared createId implementation", () => {
    const id = createId();

    expect(id).toHaveLength(24);
    expect(id).toMatch(idPattern);
  });

  it("re-exports init for deterministic generators", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));

    const first = init({ random: () => 0, counter: createCounter(0), fingerprint: "fingerprint" });
    const second = init({ random: () => 0, counter: createCounter(0), fingerprint: "fingerprint" });

    expect(first()).toBe(second());
  });
});
