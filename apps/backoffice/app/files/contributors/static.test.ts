import { describe, expect, test } from "vitest";

import {
  SYSTEM_FILE_CONTENT,
  STATIC_FILE_MOUNT_POINT,
  staticFileContributor,
  staticFileMount,
} from "@/files";

describe("static file contributor", () => {
  test("exposes the /system mount metadata", async () => {
    expect(staticFileMount).toMatchObject({
      id: "system",
      kind: "static",
      mountPoint: "/system",
      readOnly: true,
      persistence: "persistent",
    });
    expect(staticFileContributor).toMatchObject(staticFileMount);
  });

  test("renders and reads the built-in /system docs pack", async () => {
    const entries = await staticFileContributor.readdirWithFileTypes?.(STATIC_FILE_MOUNT_POINT);
    expect(await staticFileContributor.readFile?.(`${STATIC_FILE_MOUNT_POINT}/SYSTEM.md`)).toEqual(
      SYSTEM_FILE_CONTENT["SYSTEM.md"],
    );

    expect(entries?.map((entry) => entry.name)).toEqual(expect.arrayContaining(["SYSTEM.md"]));
    expect(staticFileContributor.getAllPaths?.()).toEqual(
      expect.arrayContaining([
        "/system",
        ...Object.keys(SYSTEM_FILE_CONTENT).map((path) => `/system/${path}`),
      ]),
    );
  });
});
