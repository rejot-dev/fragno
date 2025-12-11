import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ControlElement } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonFormsStateProvider } from "@jsonforms/react";
import { ShadcnNumberCellContext, shadcnNumberCellTester } from "./ShadcnNumberCell";
import { initCore, TestEmitter, createTesterContext } from "../util/test-utils";

const schema = {
  type: "object",
  properties: {
    price: { type: "number" },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/price",
};

describe("shadcnNumberCellTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/price",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnNumberCellTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnNumberCellTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-number schema", () => {
    const rootSchema = { type: "object", properties: { price: { type: "string" } } };
    expect(shadcnNumberCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE for integer schema", () => {
    const rootSchema = { type: "object", properties: { price: { type: "integer" } } };
    expect(shadcnNumberCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 2 for number schema", () => {
    const rootSchema = { type: "object", properties: { price: { type: "number" } } };
    expect(shadcnNumberCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(2);
  });
});

describe("ShadcnNumberCell", () => {
  afterEach(() => cleanup());

  it("should render input with value", () => {
    const core = initCore(schema, uischema, { price: 19.99 });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnNumberCellContext
          schema={{ type: "number" }}
          uischema={uischema}
          path="price"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const input = screen.getByRole("spinbutton");
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue(19.99);
  });

  it("should render empty input when data is undefined", () => {
    const core = initCore(schema, uischema, {});
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnNumberCellContext
          schema={{ type: "number" }}
          uischema={uischema}
          path="price"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const input = screen.getByRole("spinbutton");
    expect(input).toHaveValue(null);
  });

  it("should update value on change", () => {
    const core = initCore(schema, uischema, { price: 0 });
    const onChangeData: { data: unknown } = { data: undefined };

    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <TestEmitter
          onChange={({ data }) => {
            onChangeData.data = data;
          }}
        />
        <ShadcnNumberCellContext
          schema={{ type: "number" }}
          uischema={uischema}
          path="price"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "29.99" } });

    expect((onChangeData.data as { price: number }).price).toBe(29.99);
  });

  it("should be disabled when enabled=false", () => {
    const core = initCore(schema, uischema, { price: 19.99 });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnNumberCellContext
          schema={{ type: "number" }}
          uischema={uischema}
          path="price"
          enabled={false}
        />
      </JsonFormsStateProvider>,
    );

    const input = screen.getByRole("spinbutton");
    expect(input).toBeDisabled();
  });

  it("should handle decimal values", () => {
    const core = initCore(schema, uischema, { price: 0 });
    const onChangeData: { data: unknown } = { data: undefined };

    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <TestEmitter
          onChange={({ data }) => {
            onChangeData.data = data;
          }}
        />
        <ShadcnNumberCellContext
          schema={{ type: "number" }}
          uischema={uischema}
          path="price"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "3.14159" } });

    expect((onChangeData.data as { price: number }).price).toBe(3.14159);
  });
});
