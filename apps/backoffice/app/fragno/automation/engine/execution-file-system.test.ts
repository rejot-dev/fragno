import { describe, expect, test } from "vitest";

import { MasterFileSystem } from "@/files/master-file-system";

import { createAutomationExecutionFileSystem } from "./execution-file-system";

describe("createAutomationExecutionFileSystem", () => {
  test("only exposes the automation event at /context/event.json", async () => {
    const fs = createAutomationExecutionFileSystem({
      masterFs: new MasterFileSystem({ mounts: [] }),
      eventJson: JSON.stringify({ id: "event-1" }),
    });

    await expect(fs.readFile("/context/event.json")).resolves.toBe('{"id":"event-1"}');
    await expect(fs.readdir("/context")).resolves.toEqual(["event.json"]);
    await expect(fs.readFile("/context/typo.json")).rejects.toThrow("ENOENT");
    await expect(fs.exists("/context/typo.json")).resolves.toBe(false);
    await expect(fs.stat("/context/typo.json")).rejects.toThrow("was not found");
    await expect(fs.readdir("/context/event.json")).rejects.toThrow("not a directory");
  });
});
