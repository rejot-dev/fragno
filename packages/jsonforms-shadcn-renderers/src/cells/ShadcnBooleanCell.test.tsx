import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ControlElement } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonFormsStateProvider } from "@jsonforms/react";
import { ShadcnBooleanCellContext, shadcnBooleanCellTester } from "./ShadcnBooleanCell";
import { initCore, TestEmitter, createTesterContext } from "../util/test-utils";

const schema = {
  type: "object",
  properties: {
    foo: { type: "boolean" },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/foo",
};

describe("shadcnBooleanCellTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/foo",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnBooleanCellTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnBooleanCellTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnBooleanCellTester({ type: "Foo" }, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnBooleanCellTester({ type: "Control" }, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-boolean schema", () => {
    const rootSchema = { type: "object", properties: { foo: { type: "string" } } };
    expect(shadcnBooleanCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE when property doesn't match scope", () => {
    const rootSchema = {
      type: "object",
      properties: {
        foo: { type: "string" },
        bar: { type: "boolean" },
      },
    };
    expect(shadcnBooleanCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 2 for boolean schema", () => {
    const rootSchema = { type: "object", properties: { foo: { type: "boolean" } } };
    expect(shadcnBooleanCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(2);
  });
});

describe("ShadcnBooleanCell", () => {
  afterEach(() => cleanup());

  it("should render checkbox with checked=true when data is true", () => {
    const core = initCore(schema, uischema, { foo: true });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnBooleanCellContext
          schema={{ type: "boolean" }}
          uischema={uischema}
          path="foo"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toHaveAttribute("data-state", "checked");
  });

  it("should render checkbox with checked=false when data is false", () => {
    const core = initCore(schema, uischema, { foo: false });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnBooleanCellContext
          schema={{ type: "boolean" }}
          uischema={uischema}
          path="foo"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toHaveAttribute("data-state", "unchecked");
  });

  it("should handle undefined/null data as unchecked", () => {
    const core = initCore(schema, uischema, { foo: undefined });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnBooleanCellContext
          schema={{ type: "boolean" }}
          uischema={uischema}
          path="foo"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toHaveAttribute("data-state", "unchecked");
  });

  it("should call handleChange when clicked", () => {
    const core = initCore(schema, uischema, { foo: true });
    const onChangeData: { data: unknown } = { data: undefined };

    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <TestEmitter
          onChange={({ data }) => {
            onChangeData.data = data;
          }}
        />
        <ShadcnBooleanCellContext
          schema={{ type: "boolean" }}
          uischema={uischema}
          path="foo"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);

    expect((onChangeData.data as { foo: boolean }).foo).toBe(false);
  });

  it("should be disabled when enabled=false", () => {
    const core = initCore(schema, uischema, { foo: true });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnBooleanCellContext
          schema={{ type: "boolean" }}
          uischema={uischema}
          path="foo"
          enabled={false}
        />
      </JsonFormsStateProvider>,
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeDisabled();
  });

  it("should be enabled by default when enabled=true", () => {
    const core = initCore(schema, uischema, { foo: true });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnBooleanCellContext
          schema={{ type: "boolean" }}
          uischema={uischema}
          path="foo"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeDisabled();
  });

  it("should apply provided id", () => {
    const core = initCore(schema, uischema, { foo: true });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnBooleanCellContext
          schema={{ type: "boolean" }}
          uischema={uischema}
          path="foo"
          enabled={true}
          id="my-checkbox"
        />
      </JsonFormsStateProvider>,
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toHaveAttribute("id", "my-checkbox");
  });
});
