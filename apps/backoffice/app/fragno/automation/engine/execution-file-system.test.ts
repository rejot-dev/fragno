import { describe, expect, test } from "vitest";

import { MasterFileSystem } from "@/files/master-file-system";

import { createAutomationExecutionFileSystem } from "./execution-file-system";

describe("createAutomationExecutionFileSystem", () => {
  test("exposes automation context files under /context and device files under /dev", async () => {
    const fs = createAutomationExecutionFileSystem({
      masterFs: new MasterFileSystem({
        mounts: [],
      }),
      contextFiles: {
        "event.json": JSON.stringify({ id: "event-1" }),
      },
    });

    await expect(fs.readFile("/context/event.json")).resolves.toBe('{"id":"event-1"}');
    await expect(fs.readdir("/context")).resolves.toEqual(["event.json"]);
    await expect(fs.readFile("/context/typo.json")).rejects.toThrow("ENOENT");
    await expect(fs.exists("/context/typo.json")).resolves.toBe(false);
    await expect(fs.stat("/context/typo.json")).rejects.toThrow("ENOENT");
    await expect(fs.readdir("/context/event.json")).rejects.toThrow("not a directory");

    await expect(fs.readdir("/dev")).resolves.toEqual(["null", "zero"]);
    await fs.writeFile("/dev/null", "discarded");
    await expect(fs.readFile("/dev/null")).resolves.toBe("");
  });
});
