import { describe, expect, test } from "vitest";

import { getCodemodeResultDetails } from "./codemode-result";

describe("getCodemodeResultDetails", () => {
  test.each([
    ["absent", { result: "done" }],
    ["null", { result: "done", run: null }],
    ["undefined", { result: "done", run: undefined }],
  ])("returns no workflow run when the run field is %s", (_state, details) => {
    expect(getCodemodeResultDetails(details).runs).toEqual([]);
  });

  test("maps the public instance handle to the internal codemode host", () => {
    expect(
      getCodemodeResultDetails({
        run: { instanceId: "workflow-instance" },
      }).runs,
    ).toEqual([{ workflowName: "codemode-script", instanceId: "workflow-instance" }]);
  });

  test("follows the inline run with the saved runs the program showed", () => {
    expect(
      getCodemodeResultDetails({
        run: { instanceId: "inline" },
        shownRuns: [{ instanceId: "nightly-sync" }, { instanceId: "mirror" }],
      }).runs,
    ).toEqual([
      { workflowName: "codemode-script", instanceId: "inline" },
      { workflowName: "codemode-script", instanceId: "nightly-sync" },
      { workflowName: "codemode-script", instanceId: "mirror" },
    ]);
  });

  test("keeps historical handles compatible without trusting their workflow name", () => {
    expect(
      getCodemodeResultDetails({
        run: { workflowName: "legacy-host", instanceId: "workflow-instance" },
      }).runs,
    ).toEqual([{ workflowName: "codemode-script", instanceId: "workflow-instance" }]);
  });

  test.each([
    "workflow-instance",
    [],
    {},
    { workflowName: "codemode-script" },
    { instanceId: " " },
    { workflowName: "codemode-script", instanceId: " " },
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
