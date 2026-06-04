import { describe, expect, test } from "vitest";

import { MasterFileSystem } from "@/files/master-file-system";

import { createAutomationExecutionFileSystem } from "./execution-file-system";

describe("createAutomationExecutionFileSystem", () => {
  test("exposes automation context files under /context", async () => {
    const fs = createAutomationExecutionFileSystem({
      masterFs: new MasterFileSystem({ mounts: [] }),
      eventJson: JSON.stringify({ id: "event-1" }),
      envJson: JSON.stringify({ PI_DEFAULT_AGENT: "agent-1" }),
    });

    await expect(fs.readFile("/context/event.json")).resolves.toBe('{"id":"event-1"}');
    await expect(fs.readFile("/context/env.json")).resolves.toBe('{"PI_DEFAULT_AGENT":"agent-1"}');
    await expect(fs.readdir("/context")).resolves.toEqual(["env.json", "event.json"]);
    await expect(fs.readFile("/context/typo.json")).rejects.toThrow("ENOENT");
    await expect(fs.exists("/context/typo.json")).resolves.toBe(false);
    await expect(fs.stat("/context/typo.json")).rejects.toThrow("was not found");
    await expect(fs.readdir("/context/event.json")).rejects.toThrow("not a directory");
  });
});
