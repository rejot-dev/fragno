import { describe, expect, test, assert } from "vitest";

import { Bash } from "just-bash";

import { createTestMasterFileSystem } from "@/fragno/automation/engine/test-master-file-system.test-utils";

import { automationsCommand } from "./automations-command";

const createBash = (files: Record<string, string> = {}) =>
  new Bash({
    fs: createTestMasterFileSystem(files),
    customCommands: [automationsCommand],
  });

const AUTOMATIONS = {
  "/system/automations/onboarding.cm.js": "async () => true",
  "/workspace/automations/greet.sh": "echo hi",
  "/workspace/automations/hello.workflow.js": "export default {}",
};

describe("automations command", () => {
  test("lists automations across the system and workspace roots", async () => {
    const bash = createBash(AUTOMATIONS);

    const result = await bash.exec("automations");

    assert(result.exitCode === 0);
    expect(result.stdout).toBe(
      [
        "workspace  script    bash      /workspace/automations/greet.sh",
        "workspace  workflow  bash      /workspace/automations/hello.workflow.js",
        "system     script    codemode  /system/automations/onboarding.cm.js",
        "",
      ].join("\n"),
    );
  });

  test("defaults the same as the explicit list subcommand", async () => {
    const bash = createBash(AUTOMATIONS);

    const [bare, explicit] = await Promise.all([
      bash.exec("automations"),
      bash.exec("automations list"),
    ]);

    expect(explicit.stdout).toBe(bare.stdout);
    assert(explicit.exitCode === 0);
  });

  test("emits JSON with --format json", async () => {
    const bash = createBash(AUTOMATIONS);

    const result = await bash.exec("automations --format json");

    assert(result.exitCode === 0);
    expect(JSON.parse(result.stdout)).toEqual([
      {
        layer: "workspace",
        path: "greet.sh",
        absolutePath: "/workspace/automations/greet.sh",
        engine: "bash",
        kind: "script",
      },
      {
        layer: "workspace",
        path: "hello.workflow.js",
        absolutePath: "/workspace/automations/hello.workflow.js",
        engine: "bash",
        kind: "workflow",
      },
      {
        layer: "system",
        path: "onboarding.cm.js",
        absolutePath: "/system/automations/onboarding.cm.js",
        engine: "codemode",
        kind: "script",
      },
    ]);
  });

  test("reports an empty automations directory", async () => {
    const bash = createBash();

    const result = await bash.exec("automations");

    assert(result.exitCode === 0);
    assert(result.stdout === "No automations found.\n");
  });

  test("prints help with --help", async () => {
    const bash = createBash(AUTOMATIONS);

    const result = await bash.exec("automations --help");

    assert(result.exitCode === 0);
    expect(result.stdout).toContain("Usage: automations");
  });

  test("rejects an unknown subcommand", async () => {
    const bash = createBash(AUTOMATIONS);

    const result = await bash.exec("automations bogus");

    assert(result.exitCode === 2);
    expect(result.stderr).toContain("unknown command 'bogus'");
  });

  test("rejects an invalid --format value", async () => {
    const bash = createBash(AUTOMATIONS);

    const result = await bash.exec("automations --format xml");

    assert(result.exitCode === 2);
    expect(result.stderr).toContain("--format must be 'text' or 'json'");
  });
});
