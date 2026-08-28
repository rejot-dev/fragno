import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { enterSpan, setAttribute } = vi.hoisted(() => ({
  setAttribute: vi.fn(),
  enterSpan: vi.fn((_name: string, callback: (span: unknown) => unknown) =>
    callback({ setAttribute: vi.fn() }),
  ),
}));

vi.mock("cloudflare:workers", () => ({ tracing: { enterSpan } }));

import { cloudflareFragmentInitializationInstrumentation } from "./cloudflare-fragment-initialization-instrumentation";

describe("cloudflareFragmentInitializationInstrumentation", () => {
  beforeEach(() => {
    enterSpan.mockReset();
    setAttribute.mockReset();
    enterSpan.mockImplementation((_name: string, callback: (span: unknown) => unknown) =>
      callback({ setAttribute }),
    );
  });

  test("creates stable runtime creation and fragment migration spans", () => {
    const execute = vi.fn(() => "done");

    assert.equal(
      cloudflareFragmentInitializationInstrumentation.run(
        { phase: "createRuntime", hostName: "Automations" },
        execute,
      ),
      "done",
    );
    assert.equal(
      cloudflareFragmentInitializationInstrumentation.run(
        { phase: "migrate", hostName: "Automations", fragmentName: "automation" },
        execute,
      ),
      "done",
    );

    expect(enterSpan.mock.calls.map(([name]) => name)).toEqual([
      "fragno.fragment_runtime.create",
      "fragno.fragment.migrate",
    ]);
    expect(setAttribute.mock.calls).toEqual([
      ["fragno.runtime.host.name", "Automations"],
      ["fragno.runtime.initialization.phase", "createRuntime"],
      ["fragno.runtime.host.name", "Automations"],
      ["fragno.runtime.initialization.phase", "migrate"],
      ["fragno.db.fragment.name", "automation"],
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  test("executes without a span when Cloudflare skips the callback", () => {
    enterSpan.mockReturnValue(undefined);
    const execute = vi.fn(() => "done");

    assert.equal(
      cloudflareFragmentInitializationInstrumentation.run(
        { phase: "createRuntime", hostName: "Automations" },
        execute,
      ),
      "done",
    );
    expect(execute).toHaveBeenCalledOnce();
  });
});
