import { assert, describe, expect, test } from "vitest";

import {
  applyDashboardAutocompleteSuggestion,
  buildDashboardAutocomplete,
  extractNextCwd,
  getDashboardArgumentHints,
  getDashboardPathAutocompleteRequest,
  type DashboardCommandSpec,
  wrapDashboardCommand,
} from "./dashboard-terminal";

const commandSpecs: DashboardCommandSpec[] = [
  {
    command: "pi.session.get",
    summary: "Fetch a Pi session by id.",
    options: [
      {
        name: "session-id",
        description: "Pi session id.",
        required: true,
        valueName: "id",
        valueRequired: true,
      },
      {
        name: "format",
        description: "Output format.",
        valueName: "text|json",
        valueRequired: true,
      },
    ],
  },
  {
    command: "pi.session.list",
    summary: "List Pi sessions.",
    options: [],
  },
];

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

describe("dashboard terminal autocomplete", () => {
  test("returns newest matching history commands for ctrl+r", () => {
    const suggestions = buildDashboardAutocomplete({
      commandLine: "session",
      commandSpecs,
      history: ["ls /workspace", "pi.session.list", "pi.session.get --session-id abc"],
      mode: "history",
    });

    expect(suggestions.map((suggestion) => suggestion.label)).toEqual([
      "pi.session.get --session-id abc",
      "pi.session.list",
    ]);
    assert.equal(
      applyDashboardAutocompleteSuggestion("session", suggestions[0]!),
      "pi.session.get --session-id abc",
    );
  });

  test("completes command names from runtime tool specs", () => {
    const suggestions = buildDashboardAutocomplete({
      commandLine: "pi.sess",
      commandSpecs,
      history: [],
      mode: "completion",
    });

    expect(suggestions.map((suggestion) => suggestion.label)).toEqual([
      "pi.session.get",
      "pi.session.list",
    ]);
    assert.equal(
      applyDashboardAutocompleteSuggestion("pi.sess", suggestions[0]!),
      "pi.session.get ",
    );
  });

  test("suggests unused command arguments with descriptions", () => {
    const suggestions = buildDashboardAutocomplete({
      commandLine: "pi.session.get --",
      commandSpecs,
      history: [],
      mode: "completion",
    });

    expect(suggestions.map((suggestion) => [suggestion.label, suggestion.description])).toEqual([
      ["--session-id <id>", "Pi session id."],
      ["--format <text|json>", "Output format."],
    ]);
    assert.equal(
      applyDashboardAutocompleteSuggestion("pi.session.get --", suggestions[0]!),
      "pi.session.get --session-id ",
    );
  });

  test("builds path completion requests for shell command path arguments", () => {
    expect(
      getDashboardPathAutocompleteRequest({
        commandLine: "cd /workspace/bla",
        cwd: "/",
      }),
    ).toMatchObject({
      intent: "autocomplete-path",
      parentPath: "/workspace/",
      query: "bla",
      replacementStart: 3,
      replacementEnd: 17,
      directoriesOnly: true,
    });
  });

  test("completes shell command paths from filesystem suggestions", () => {
    const request = getDashboardPathAutocompleteRequest({
      commandLine: "cd /workspace/bla",
      cwd: "/",
    });
    assert(request);

    const suggestions = buildDashboardAutocomplete({
      commandLine: "cd /workspace/bla",
      commandSpecs,
      currentCwd: "/",
      history: [],
      mode: "completion",
      pathAutocompleteResult: {
        ...request,
        ok: true,
        entries: [
          { name: "blackbird", path: "/workspace/blackbird", isDirectory: true },
          { name: "blame.txt", path: "/workspace/blame.txt", isDirectory: false },
        ],
      },
    });

    expect(suggestions.map((suggestion) => [suggestion.kind, suggestion.label])).toEqual([
      ["path", "/workspace/blackbird/"],
      ["path", "/workspace/blame.txt"],
    ]);
    assert.equal(
      applyDashboardAutocompleteSuggestion("cd /workspace/bla", suggestions[0]!),
      "cd /workspace/blackbird/",
    );
  });

  test("returns argument hints and marks already-used options", () => {
    const hints = getDashboardArgumentHints({
      commandLine: "pi.session.get --session-id abc",
      commandSpecs,
    });

    expect(hints.map((hint) => [hint.name, hint.used, hint.description])).toEqual([
      ["session-id", true, "Pi session id."],
      ["format", false, "Output format."],
    ]);
  });
});
