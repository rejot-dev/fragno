import { assert, describe, expect, test, vi } from "vitest";

import { normalizeCode, resolveProvider } from "@fragno-dev/codemode/runtime-api";

describe("resolveProvider", () => {
  test("calls no-input tools without a synthetic empty object and rejects arguments", async () => {
    const execute = vi.fn(() => "ok");
    const provider = resolveProvider({
      name: "example",
      tools: {
        ping: {
          inputMode: "none",
          execute,
        },
      },
    });

    await expect(provider.fns.ping()).resolves.toBe("ok");
    expect(execute).toHaveBeenCalledWith(undefined);
    await expect(provider.fns.ping({})).rejects.toThrow(
      "Tool 'example.ping' does not accept arguments.",
    );
  });
});

describe("normalizeCode", () => {
  test("trims surrounding whitespace", () => {
    assert(normalizeCode("  defineWorkflow({})  ") === "defineWorkflow({})");
  });

  test("strips a leading `return` so the snippet stays a valid expression", () => {
    // The executor injects the snippet as `(<code>)`, where a leading `return`
    // statement is a SyntaxError ("Unexpected token 'return'").
    assert(
      normalizeCode("return defineWorkflow({ name: 'x' }, async () => {})") ===
        "defineWorkflow({ name: 'x' }, async () => {})",
    );
  });

  test("strips a leading `return` directly followed by a paren/brace", () => {
    assert(normalizeCode("return(42)") === "(42)");
    assert(normalizeCode("return\n  defineWorkflow({})") === "defineWorkflow({})");
  });

  test("does not strip `return` that is not at the top level", () => {
    const code =
      "async () => { return await state.readFile({ path: '/workspace/codemode.d.ts' }); }";
    expect(normalizeCode(code)).toBe(code);
  });

  test("does not strip identifiers that merely start with `return`", () => {
    assert(normalizeCode("returnValue") === "returnValue");
  });
});
