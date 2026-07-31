import { describe, expect, test } from "vitest";

import { getExecCodeModeResultDetails } from "./exec-code-mode";

describe("getExecCodeModeResultDetails", () => {
  test.each([
    ["absent", { result: "done" }],
    ["null", { result: "done", run: null }],
    ["undefined", { result: "done", run: undefined }],
  ])("returns no workflow run when the run field is %s", (_state, details) => {
    expect(getExecCodeModeResultDetails(details).run).toBeNull();
  });

  test("parses a present workflow run reference", () => {
    expect(
      getExecCodeModeResultDetails({
        run: { workflowName: "pi-codemode-script", instanceId: "workflow-instance" },
      }).run,
    ).toEqual({ workflowName: "pi-codemode-script", instanceId: "workflow-instance" });
  });

  test.each([
    "workflow-instance",
    [],
    {},
    { workflowName: "pi-codemode-script" },
    { instanceId: "workflow-instance" },
    { workflowName: "", instanceId: "workflow-instance" },
    { workflowName: "pi-codemode-script", instanceId: " " },
  ])("throws when a present workflow run reference is malformed: %j", (run) => {
    expect(() => getExecCodeModeResultDetails({ run })).toThrow(
      new TypeError(
        "Invalid execCodeMode result details.run: expected non-empty workflowName and instanceId strings",
      ),
    );
  });
});
