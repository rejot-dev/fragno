import { describe, expect, it, vi } from "vitest";

import { DurableHooksLogger } from "./durable-hooks-logger";

let namespaceCounter = 0;

function nextNamespace(): string {
  return `durable-hooks-logger-test-${namespaceCounter++}`;
}

describe("DurableHooksLogger", () => {
  it("suppresses warnings by default during test execution", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    DurableHooksLogger.warn("test warning", { namespace: nextNamespace() });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("allows tests to opt warnings back in explicitly", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const namespace = nextNamespace();

    DurableHooksLogger.configure({ level: "warn" }, namespace);
    DurableHooksLogger.warn("test warning", { namespace });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
