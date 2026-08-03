import { describe, expect, test } from "vitest";

import { SYSTEM_FILE_CONTENT, systemFileCollection } from "./system";

describe("Backoffice system file collection", () => {
  test("exposes system files as a static collection", async () => {
    const tree = await systemFileCollection.getTree();
    expect(tree.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["README.md", "automations"]),
    );

    const readme = await systemFileCollection.getFile("README.md");
    expect(readme).not.toBeNull();
    expect(readme).toMatchObject({ contentType: "text/markdown" });
    expect(await new Response(readme!.body).text()).toBe(SYSTEM_FILE_CONTENT["README.md"]);
  });
});
