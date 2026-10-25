import { describe, expect, test } from "vitest";

import { getCodemodeResultDetails } from "./codemode-result";

describe("getCodemodeResultDetails", () => {
  test.each([
    ["absent", { result: "done" }],
    ["null", { result: "done", run: null }],
    ["undefined", { result: "done", run: undefined }],
  ])("returns no workflow run when the run field is %s", (_state, details) => {
    expect(getCodemodeResultDetails(details).run).toBeNull();
  });

  test("maps the public instance handle to the internal codemode host", () => {
    expect(
      getCodemodeResultDetails({
        run: { instanceId: "workflow-instance" },
      }).run,
    ).toEqual({ workflowName: "codemode-script", instanceId: "workflow-instance" });
  });

  test("keeps historical handles compatible without trusting their workflow name", () => {
    expect(
      getCodemodeResultDetails({
        run: { workflowName: "legacy-host", instanceId: "workflow-instance" },
      }).run,
    ).toEqual({ workflowName: "codemode-script", instanceId: "workflow-instance" });
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
});
