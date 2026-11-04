import { describe, expect, test } from "vitest";

import { formatToolArgumentsDisplayText } from "./tool-arguments";

describe("formatToolArgumentsDisplayText", () => {
  test("renders streaming codemode code input before the JSON argument is complete", () => {
    expect(
      formatToolArgumentsDisplayText({
        rawText:
          '{"code":"const path = \\"/tmp/example.txt\\";\\nawait state.writeFile(path, \\"hello',
        value: { code: "" },
      }),
    ).toContain('await state.writeFile(path, "hello');
  });
});
