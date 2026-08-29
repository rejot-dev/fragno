import { describe, expect, test } from "vitest";

import type { DashboardCommandSpec } from "./dashboard-terminal";
import { generateBackofficeTerminalCommandSpecJson } from "./terminal-command-spec-generation";

describe("generateBackofficeTerminalCommandSpecJson", () => {
  test("includes isomorphic-git command metadata", () => {
    const specs = JSON.parse(generateBackofficeTerminalCommandSpecJson()) as DashboardCommandSpec[];
    const gitSpecs = specs.filter((spec) => spec.command.startsWith("git."));

    expect(gitSpecs.map((spec) => spec.command)).toEqual(["git.clone", "git.status", "git.call"]);
    expect(
      gitSpecs.find((spec) => spec.command === "git.clone")?.options.map(({ name }) => name),
    ).toEqual(["help", "depth", "ref", "max-files", "max-bytes"]);
    expect(
      gitSpecs.find((spec) => spec.command === "git.status")?.options.map(({ name }) => name),
    ).toEqual(["help", "dir"]);
  });
});
