import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveInMemoryAdapterOptions } from "./options";

describe("resolveInMemoryAdapterOptions", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates deterministic ids when seeded", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));

    const first = resolveInMemoryAdapterOptions({ idSeed: "seed" }).idGenerator;
    const second = resolveInMemoryAdapterOptions({ idSeed: "seed" }).idGenerator;

    const firstIds = [first(), first(), first()];
    const secondIds = [second(), second(), second()];

    expect(firstIds).toEqual(secondIds);
  });

  it("provides a monotonic internal id generator", () => {
    const generator = resolveInMemoryAdapterOptions({ idSeed: "seed" }).internalIdGenerator;

    expect(generator()).toBe(1n);
    expect(generator()).toBe(2n);
  });

  it("defaults enforceConstraints and btreeOrder", () => {
    const options = resolveInMemoryAdapterOptions({ idSeed: "seed" });

    expect(options.enforceConstraints).toBe(true);
    expect(options.btreeOrder).toBe(32);
  });

  it("defaults to a clock that returns dates", () => {
    const options = resolveInMemoryAdapterOptions({ idSeed: "seed" });

    expect(options.clock.now()).toBeInstanceOf(Date);
  });
});
