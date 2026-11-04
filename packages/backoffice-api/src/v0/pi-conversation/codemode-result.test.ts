import { describe, expect, test } from "vitest";

import { getCodemodeResultDetails } from "./codemode-result";

describe("getCodemodeResultDetails", () => {
  test("reads the result, even an undefined one, and the logs' lines of text", () => {
    expect(getCodemodeResultDetails({ result: undefined, logs: ["one", 2, "three"] })).toEqual({
      hasResult: true,
      logs: ["one", "three"],
      result: undefined,
      runs: [],
      calls: null,
    });
  });

  test.each([null, "details", ["result"]])(
    "details that are not a record hold nothing: %j",
    (details) => {
      expect(getCodemodeResultDetails(details)).toEqual({
        hasResult: false,
        logs: [],
        result: undefined,
        runs: [],
        calls: null,
      });
    },
  );

  test.each([
    ["absent", { result: "done" }],
    ["null", { result: "done", run: null }],
    ["undefined", { result: "done", run: undefined }],
  ])("returns no workflow run when the run field is %s", (_state, details) => {
    expect(getCodemodeResultDetails(details).runs).toEqual([]);
  });

  test("reads the run the program started by its instance", () => {
    expect(
      getCodemodeResultDetails({
        run: { instanceId: "workflow-instance" },
      }).runs,
    ).toEqual([{ instanceId: "workflow-instance" }]);
  });

  test("follows the inline run with the saved runs the program showed", () => {
    expect(
      getCodemodeResultDetails({
        run: { instanceId: "inline" },
        shownRuns: [{ instanceId: "nightly-sync" }, { instanceId: "mirror" }],
      }).runs,
    ).toEqual([{ instanceId: "inline" }, { instanceId: "nightly-sync" }, { instanceId: "mirror" }]);
  });

  test("keeps historical handles compatible without trusting their workflow name", () => {
    expect(
      getCodemodeResultDetails({
        run: { workflowName: "legacy-host", instanceId: "workflow-instance" },
      }).runs,
    ).toEqual([{ instanceId: "workflow-instance" }]);
  });

  test.each([
    "workflow-instance",
    [],
    {},
    { workflowName: "codemode-script" },
    { instanceId: " " },
    { instanceId: " " },
  ])("throws when a present workflow run reference is malformed: %j", (run) => {
    expect(() => getCodemodeResultDetails({ run })).toThrow(
      new TypeError("Invalid codemode result details.run: expected a non-empty instanceId string"),
    );
  });

  test.each([{}, [{ instanceId: " " }], ["mirror"]])(
    "throws when present shown runs are malformed: %j",
    (shownRuns) => {
      expect(() => getCodemodeResultDetails({ shownRuns })).toThrow(
        new TypeError(
          "Invalid codemode result details.shownRuns: expected a non-empty instanceId string",
        ),
      );
    },
  );
});
