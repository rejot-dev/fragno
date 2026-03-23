import { describe, expect, test } from "vitest";

import { extractNextCwd, wrapDashboardCommand } from "./dashboard-terminal";

describe("dashboard terminal cwd tracking", () => {
  test("wraps commands with cwd marker reporting", () => {
    const wrapped = wrapDashboardCommand("cd /workspace");

    expect(wrapped).toContain("cd /workspace");
    expect(wrapped).toContain("__fragno_dashboard_exit=$?");
    expect(wrapped).toContain("__FRAGNO_BACKOFFICE_CWD__");
    expect(wrapped).toContain('exit "$__fragno_dashboard_exit"');
  });

  test("extracts the next cwd and removes the marker from stderr", () => {
    expect(
      extractNextCwd("warning: something happened\n__FRAGNO_BACKOFFICE_CWD__/workspace\n", "/"),
    ).toEqual({
      stderr: "warning: something happened",
      nextCwd: "/workspace",
    });
  });

  test("falls back to the submitted cwd when no marker is present", () => {
    expect(extractNextCwd("plain stderr", "/workspace")).toEqual({
      stderr: "plain stderr",
      nextCwd: "/workspace",
    });
  });
});
