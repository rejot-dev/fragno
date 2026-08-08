import { describe, expect, test, vi, assert } from "vitest";

import { STATIC_FILE_CONTENT, createBackofficeStaticFileCollection } from "./static";

describe("Backoffice static file collection", () => {
  test("combines built-in files with loaded static artifacts", async () => {
    const loadStaticFileArtifacts = vi.fn(() => ({
      "codemode/system.d.ts": "declare const configured: true;",
    }));
    const collection = createBackofficeStaticFileCollection(loadStaticFileArtifacts);

    const tree = await collection.getTree();
    expect(tree.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        "SYSTEM.md",
        "codemode",
        "codemode/system.d.ts",
        "docs/README.md",
        "docs/automations/scripts.md",
        "skills/generating-backoffice-uis/SKILL.md",
      ]),
    );

    const loadedFile = await collection.getFile("codemode/system.d.ts");
    expect(loadedFile).not.toBeNull();
    assert((await new Response(loadedFile!.body).text()) === "declare const configured: true;");
    expect(loadStaticFileArtifacts).toHaveBeenCalledTimes(1);
  });

  test("searches built-in and loaded static file contents", async () => {
    const collection = createBackofficeStaticFileCollection(() => ({
      "codemode/system.d.ts": "declare const configured: true;",
    }));

    const matches = await collection.search("configured");

    expect(matches).toContainEqual(
      expect.objectContaining({
        path: "codemode/system.d.ts",
        line: 1,
        column: 15,
        text: "configured",
      }),
    );
  });

  test("streams built-in static content", async () => {
    const collection = createBackofficeStaticFileCollection(() => ({}));
    const file = await collection.getFile("SYSTEM.md");

    expect(file).not.toBeNull();
    expect(file).toMatchObject({ contentType: "text/markdown" });
    expect(await new Response(file!.body).text()).toBe(STATIC_FILE_CONTENT["SYSTEM.md"]);
  });
});
