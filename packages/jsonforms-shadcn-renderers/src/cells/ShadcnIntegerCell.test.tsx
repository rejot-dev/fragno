import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ControlElement } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonFormsStateProvider } from "@jsonforms/react";
import { ShadcnIntegerCellContext, shadcnIntegerCellTester } from "./ShadcnIntegerCell";
import { initCore, TestEmitter, createTesterContext } from "../util/test-utils";

const schema = {
  type: "object",
  properties: {
    age: { type: "integer" },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/age",
};

describe("shadcnIntegerCellTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/age",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnIntegerCellTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnIntegerCellTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-integer schema", () => {
    const rootSchema = { type: "object", properties: { age: { type: "string" } } };
    expect(shadcnIntegerCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE for number schema", () => {
    const rootSchema = { type: "object", properties: { age: { type: "number" } } };
    expect(shadcnIntegerCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 2 for integer schema", () => {
    const rootSchema = { type: "object", properties: { age: { type: "integer" } } };
    expect(shadcnIntegerCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(2);
  });
});

describe("ShadcnIntegerCell", () => {
  afterEach(() => cleanup());

  it("should render input with value", () => {
    const core = initCore(schema, uischema, { age: 25 });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnIntegerCellContext
          schema={{ type: "integer" }}
          uischema={uischema}
          path="age"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const input = screen.getByRole("spinbutton");
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue(25);
  });

  it("should render empty input when data is undefined", () => {
    const core = initCore(schema, uischema, {});
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnIntegerCellContext
          schema={{ type: "integer" }}
          uischema={uischema}
          path="age"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const input = screen.getByRole("spinbutton");
    expect(input).toHaveValue(null);
  });

  it("should update value on change", () => {
    const core = initCore(schema, uischema, { age: 0 });
    const onChangeData: { data: unknown } = { data: undefined };

    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <TestEmitter
          onChange={({ data }) => {
            onChangeData.data = data;
          }}
        />
        <ShadcnIntegerCellContext
          schema={{ type: "integer" }}
          uischema={uischema}
          path="age"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "30" } });

    expect((onChangeData.data as { age: number }).age).toBe(30);
  });

  it("should be disabled when enabled=false", () => {
    const core = initCore(schema, uischema, { age: 25 });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnIntegerCellContext
          schema={{ type: "integer" }}
          uischema={uischema}
          path="age"
          enabled={false}
        />
      </JsonFormsStateProvider>,
    );

    const input = screen.getByRole("spinbutton");
    expect(input).toBeDisabled();
  });

  it("should have step=1 for integers", () => {
    const core = initCore(schema, uischema, { age: 25 });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnIntegerCellContext
          schema={{ type: "integer" }}
          uischema={uischema}
          path="age"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const input = screen.getByRole("spinbutton");
    expect(input).toHaveAttribute("step", "1");
  });
});
