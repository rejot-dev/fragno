import { describe, expect, test } from "vitest";

import {
  STATIC_STARTER_CONTENT,
  STATIC_STARTER_FILE_MOUNT_POINT,
  createStaticStarterMountedFileSystem,
  staticStarterFileContributor,
  staticStarterFileMount,
} from "@/files";

describe("static starter file contributor", () => {
  test("exposes the /starter static mount metadata", () => {
    expect(staticStarterFileMount).toMatchObject({
      id: "static-starter",
      kind: "static",
      mountPoint: "/starter",
      title: "Static Starter",
      readOnly: true,
      persistence: "persistent",
    });
    expect(staticStarterFileContributor).toMatchObject(staticStarterFileMount);
  });

  test("renders and reads the static starter pack", async () => {
    const fs = createStaticStarterMountedFileSystem();
    const entries = await fs.readdirWithFileTypes(STATIC_STARTER_FILE_MOUNT_POINT);
    const readme = await fs.readFile(`${STATIC_STARTER_FILE_MOUNT_POINT}/README.md`);
    const bindingsManifest = await fs.readFile(
      `${STATIC_STARTER_FILE_MOUNT_POINT}/automations/bindings.json`,
    );

    expect(entries.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["README.md", "automations", "input", "output", "prompts"]),
    );
    expect(fs.getAllPaths()).toEqual(
      expect.arrayContaining([
        "/starter",
        ...Object.keys(STATIC_STARTER_CONTENT).map((path) => `/starter/${path}`),
      ]),
    );
    expect(readme).toContain("Static starter content");
    expect(bindingsManifest).toContain('"bindings"');
    expect(bindingsManifest).toContain(
      '"path": "/starter/automations/scripts/telegram-claim-linking.start.cm.js"',
    );
  });

  test("is always read-only and independent of Upload", async () => {
    const fs = createStaticStarterMountedFileSystem();

    await expect(fs.readFile("/starter/README.md")).resolves.toContain("Static starter content");
    await expect(fs.writeFile("/starter/new.md", "hello")).rejects.toThrow(/read-only/i);
  });
});
