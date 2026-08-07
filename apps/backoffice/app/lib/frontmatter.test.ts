import { describe, expect, test } from "vitest";

import { parseFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
  test("does not treat a prefixed body line as the closing delimiter", () => {
    const content = "---\nname: explorer\n---draft\n# Instructions";

    expect(parseFrontmatter(content)).toEqual({
      ok: true,
      value: { frontmatter: {}, body: content },
    });
  });
});
