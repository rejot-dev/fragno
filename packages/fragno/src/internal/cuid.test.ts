import { afterEach, describe, expect, it, vi } from "vitest";

import { createId, init } from "./cuid";

const idPattern = /^[a-z][0-9a-z]*$/;

const createSeededRandom = (seed: number) => {
  let state = seed >>> 0;

  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
};

const createCounter = (start = 0) => {
  let value = start;
  return () => value++;
};

describe("cuid", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates ids with the default format", () => {
    const id = createId();

    expect(id).toHaveLength(24);
    expect(id).toMatch(idPattern);
  });

  it("defers default state initialization until the first generated id", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));

    const random = vi.fn(() => 0.5);

    const generator = init({ random });

    expect(random).not.toHaveBeenCalled();

    generator();

    expect(random).toHaveBeenCalled();
  });

  it("uses web-standard crypto randomness by default", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));

    const mathRandomSpy = vi.spyOn(Math, "random");
    const getRandomValuesSpy = vi.spyOn(globalThis.crypto, "getRandomValues");

    const generator = init();
    const ids = Array.from({ length: 10 }, () => generator());

    expect(ids[0]).toHaveLength(24);
    expect(ids[0]).toMatch(idPattern);
    expect(mathRandomSpy).not.toHaveBeenCalled();
    expect(getRandomValuesSpy).toHaveBeenCalled();
  });

  it("supports exact custom lengths including very short ids", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));

    for (const length of [1, 2, 8, 24, 32]) {
      const id = init({
        length,
        random: createSeededRandom(123),
        counter: createCounter(7),
        fingerprint: "fingerprint",
      })();

      expect(id).toHaveLength(length);
      expect(id).toMatch(idPattern);
    }
  });

  it("creates deterministic sequences for the same configuration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));

    const first = init({
      random: createSeededRandom(123),
      counter: createCounter(10),
      fingerprint: "fingerprint",
    });
    const second = init({
      random: createSeededRandom(123),
      counter: createCounter(10),
      fingerprint: "fingerprint",
    });

    const firstIds = [first(), first(), first()];
    const secondIds = [second(), second(), second()];

    expect(firstIds).toEqual(secondIds);
    expect(firstIds).toMatchInlineSnapshot(`
      [
        "h1bh5y4k2htp1bh5y4k2htp1",
        "p1zxk77n8dqx1zxk77n8dqx1",
        "u576un0v3is576un0v3is576",
      ]
    `);
  });

  it("changes the output when the fingerprint changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));

    const withFirstFingerprint = init({
      random: createSeededRandom(123),
      counter: createCounter(10),
      fingerprint: "fingerprint-a",
    });
    const withSecondFingerprint = init({
      random: createSeededRandom(123),
      counter: createCounter(10),
      fingerprint: "fingerprint-b",
    });

    expect(withFirstFingerprint()).not.toBe(withSecondFingerprint());
  });

  it("remains collision-free across many ids even when time and random are fixed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));

    const generator = init({
      random: () => 0,
      counter: createCounter(0),
      fingerprint: "fingerprint",
    });

    const ids = Array.from({ length: 1000 }, () => generator());

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length === 24 && idPattern.test(id))).toBe(true);
  });

  it("uses the configured random source for the leading character", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));

    const leadingA = init({
      length: 8,
      random: () => 0,
      counter: createCounter(0),
      fingerprint: "fingerprint",
    })();
    const leadingZ = init({
      length: 8,
      random: () => 0.999999,
      counter: createCounter(0),
      fingerprint: "fingerprint",
    })();

    expect(leadingA[0]).toBe("a");
    expect(leadingZ[0]).toBe("z");
  });
});
