import { describe, expect, test, assert } from "vitest";

import { normalizeCode } from "./runtime-api";

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
    const code = "async () => { return await state.readFile('/workspace/codemode.d.ts'); }";
    expect(normalizeCode(code)).toBe(code);
  });

  test("does not strip identifiers that merely start with `return`", () => {
    assert(normalizeCode("returnValue") === "returnValue");
  });
});
