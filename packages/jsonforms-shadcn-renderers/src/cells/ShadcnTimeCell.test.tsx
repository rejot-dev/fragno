import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import type { ControlElement } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonFormsStateProvider } from "@jsonforms/react";
import { ShadcnTimeCellContext, shadcnTimeCellTester } from "./ShadcnTimeCell";
import { initCore, TestEmitter, createTesterContext } from "../util/test-utils";

const schema = {
  type: "object",
  properties: {
    startTime: { type: "string", format: "time" },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/startTime",
};

describe("shadcnTimeCellTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/startTime",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnTimeCellTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnTimeCellTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-time schema", () => {
    const rootSchema = { type: "object", properties: { startTime: { type: "string" } } };
    expect(shadcnTimeCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 2 for time format schema", () => {
    const rootSchema = {
      type: "object",
      properties: { startTime: { type: "string", format: "time" } },
    };
    expect(shadcnTimeCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(2);
  });
});

describe("ShadcnTimeCell", () => {
  afterEach(() => cleanup());

  const getTimeInput = () => document.querySelector('input[type="time"]') as HTMLInputElement;

  it("should render time input", () => {
    const core = initCore(schema, uischema, { startTime: "09:00:00" });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnTimeCellContext
          schema={{ type: "string", format: "time" }}
          uischema={uischema}
          path="startTime"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const input = getTimeInput();
    expect(input).toBeInTheDocument();
    // Native time input displays HH:mm even when data is HH:mm:ss
    expect(input).toHaveValue("09:00");
  });

  it("should render empty input when data is undefined", () => {
    const core = initCore(schema, uischema, {});
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnTimeCellContext
          schema={{ type: "string", format: "time" }}
          uischema={uischema}
          path="startTime"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const input = getTimeInput();
    expect(input).toHaveValue("");
  });

  it("should update value on change with seconds appended", () => {
    const core = initCore(schema, uischema, { startTime: "" });
    const onChangeData: { data: unknown } = { data: undefined };

    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <TestEmitter
          onChange={({ data }) => {
            onChangeData.data = data;
          }}
        />
        <ShadcnTimeCellContext
          schema={{ type: "string", format: "time" }}
          uischema={uischema}
          path="startTime"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const input = getTimeInput();
    fireEvent.change(input, { target: { value: "14:30" } });

    // Should output HH:mm:ss format for JSON Schema compliance
    expect((onChangeData.data as { startTime: string }).startTime).toBe("14:30:00");
  });

  it("should be disabled when enabled=false", () => {
    const core = initCore(schema, uischema, {});
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnTimeCellContext
          schema={{ type: "string", format: "time" }}
          uischema={uischema}
          path="startTime"
          enabled={false}
        />
      </JsonFormsStateProvider>,
    );

    const input = getTimeInput();
    expect(input).toBeDisabled();
  });
});
