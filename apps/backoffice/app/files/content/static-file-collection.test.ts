import { describe, expect, test } from "vitest";

import { createBackofficeSystemStateBackend } from "@/fragno/codemode/state-backend";
import { loadBackofficePiSkills } from "@/fragno/pi/extensions/backoffice/skills";

import { createStaticFileCollection } from "../../file-collection/create-static-file-collection";
import { STATIC_FILE_CONTENT, createBackofficeStaticFileCollection } from "./static";

describe("Backoffice static file collection", () => {
  test("streams built-in guidance and discovers the publishing skill through the static filesystem", async () => {
    const collection = createBackofficeStaticFileCollection();
    const file = await collection.getFile("SYSTEM.md");

    expect(file).not.toBeNull();
    expect(file).toMatchObject({ contentType: "text/markdown" });
    expect(await new Response(file!.body).text()).toBe(STATIC_FILE_CONTENT["SYSTEM.md"]);

    const skills = await loadBackofficePiSkills(
      createBackofficeSystemStateBackend({
        systemFileCollection: createStaticFileCollection({}),
        staticFileCollection: collection,
      }),
    );
    expect(skills["marketplace-publishing"]).toMatchObject({
      name: "marketplace-publishing",
      location: "/static/skills/marketplace-publishing/SKILL.md",
      directory: "/static/skills/marketplace-publishing",
      description: expect.stringContaining("Publish workspace packages to Marketplace"),
    });
    expect(skills["marketplace-publishing"].body).toContain(
      "/static/codemode/providers/marketplace.d.ts",
    );
    expect(await collection.getFile("marketplace/publishing.md")).toBeNull();
  });
});
