import { describe, expect, test, vi, assert } from "vitest";

import { STATIC_FILE_CONTENT, createBackofficeStaticFileCollection } from "./static";

describe("Backoffice static file collection", () => {
  test("loads organization-specific MCP declarations without blocking the static tree", async () => {
    const loadStaticFileArtifacts = vi.fn(() => ({
      "codemode/sources/mcp.d.ts": "declare const configured: true;",
    }));
    const collection = createBackofficeStaticFileCollection(loadStaticFileArtifacts);

    const tree = await collection.getTree();
    expect(tree.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        "SYSTEM.md",
        "codemode",
        "codemode/system.d.ts",
        "codemode/providers/telegram.d.ts",
        "codemode/sources/mcp.d.ts",
        "skills/generating-backoffice-uis/SKILL.md",
      ]),
    );
    expect(loadStaticFileArtifacts).not.toHaveBeenCalled();

    const loadedFile = await collection.getFile("codemode/sources/mcp.d.ts");
    expect(loadedFile).not.toBeNull();
    assert((await new Response(loadedFile!.body).text()) === "declare const configured: true;");
    expect(loadStaticFileArtifacts).toHaveBeenCalledTimes(1);
  });

  test("searches built-in and loaded static file contents", async () => {
    const collection = createBackofficeStaticFileCollection(() => ({
      "codemode/sources/mcp.d.ts": "declare const configured: true;",
    }));

    const { matches } = await collection.searchFiles("**", "configured");

    expect(matches).toContainEqual(
      expect.objectContaining({
        path: "codemode/sources/mcp.d.ts",
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
