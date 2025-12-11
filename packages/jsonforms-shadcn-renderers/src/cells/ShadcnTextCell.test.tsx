import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ControlElement } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonFormsStateProvider } from "@jsonforms/react";
import { ShadcnTextCellContext, shadcnTextCellTester } from "./ShadcnTextCell";
import { initCore, TestEmitter, createTesterContext } from "../util/test-utils";

const schema = {
  type: "object",
  properties: {
    name: { type: "string" },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/name",
};

describe("shadcnTextCellTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/name",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnTextCellTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnTextCellTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-string schema", () => {
    const rootSchema = { type: "object", properties: { name: { type: "number" } } };
    expect(shadcnTextCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 1 for string schema", () => {
    const rootSchema = { type: "object", properties: { name: { type: "string" } } };
    expect(shadcnTextCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(1);
  });
});

describe("ShadcnTextCell", () => {
  afterEach(() => cleanup());

  it("should render input with value", () => {
    const core = initCore(schema, uischema, { name: "John" });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnTextCellContext
          schema={{ type: "string" }}
          uischema={uischema}
          path="name"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const input = screen.getByRole("textbox");
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue("John");
  });

  it("should render empty input when data is undefined", () => {
    const core = initCore(schema, uischema, {});
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnTextCellContext
          schema={{ type: "string" }}
          uischema={uischema}
          path="name"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("");
  });

  it("should update value on change", () => {
    const core = initCore(schema, uischema, { name: "" });
    const onChangeData: { data: unknown } = { data: undefined };

    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <TestEmitter
          onChange={({ data }) => {
            onChangeData.data = data;
          }}
        />
        <ShadcnTextCellContext
          schema={{ type: "string" }}
          uischema={uischema}
          path="name"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Jane" } });

    expect((onChangeData.data as { name: string }).name).toBe("Jane");
  });

  it("should be disabled when enabled=false", () => {
    const core = initCore(schema, uischema, { name: "John" });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnTextCellContext
          schema={{ type: "string" }}
          uischema={uischema}
          path="name"
          enabled={false}
        />
      </JsonFormsStateProvider>,
    );

    const input = screen.getByRole("textbox");
    expect(input).toBeDisabled();
  });

  it("should apply provided id", () => {
    const core = initCore(schema, uischema, { name: "John" });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnTextCellContext
          schema={{ type: "string" }}
          uischema={uischema}
          path="name"
          enabled={true}
          id="my-input"
        />
      </JsonFormsStateProvider>,
    );

    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("id", "my-input");
  });
});
