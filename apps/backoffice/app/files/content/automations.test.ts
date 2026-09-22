import { describe, expect, test } from "vitest";

import { WORKSPACE_STARTER_CONTENT } from "./starter";

describe("automation content", () => {
  test("workspace starter content contains no domain automation workflows", () => {
    expect(
      Object.keys(WORKSPACE_STARTER_CONTENT).filter((path) => path.endsWith(".workflow.js")),
    ).toEqual([]);
  });
});
