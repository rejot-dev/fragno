import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { enterSpan, setAttribute, setAttributes } = vi.hoisted(() => ({
  setAttribute: vi.fn(),
  setAttributes: vi.fn(),
  enterSpan: vi.fn((_name: string, callback: (span: unknown) => unknown) =>
    callback({ setAttribute: vi.fn() }),
  ),
}));

vi.mock("cloudflare:workers", () => ({ tracing: { enterSpan } }));

import { createCloudflareFragmentInitializationInstrumentation } from "./cloudflare-fragment-initialization-instrumentation";

const orgScope = { scope: "org/org-1", scopeKind: "org", orgId: "org-1" };
const cloudflareFragmentInitializationInstrumentation =
  createCloudflareFragmentInitializationInstrumentation(orgScope);

describe("cloudflareFragmentInitializationInstrumentation", () => {
  beforeEach(() => {
    enterSpan.mockReset();
    setAttribute.mockReset();
    setAttributes.mockReset();
    enterSpan.mockImplementation((_name: string, callback: (span: unknown) => unknown) =>
      callback({ setAttribute, setAttributes }),
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
    expect(setAttributes).toHaveBeenCalledWith({
      "backoffice.scope": "org/org-1",
      "backoffice.scope_kind": "org",
      "backoffice.org_id": "org-1",
    });
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
