import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ControlElement } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonFormsStateProvider } from "@jsonforms/react";
import { ShadcnEnumRadioCellContext, shadcnEnumRadioCellTester } from "./ShadcnEnumRadioCell";
import { initCore, TestEmitter, createTesterContext } from "../util/test-utils";

const schema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["pending", "active", "completed"],
    },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/status",
  options: {
    format: "radio",
  },
};

describe("shadcnEnumRadioCellTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/status",
    options: {
      format: "radio",
    },
  };

  const controlWithoutRadio: ControlElement = {
    type: "Control",
    scope: "#/properties/status",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnEnumRadioCellTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnEnumRadioCellTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-enum schema", () => {
    const rootSchema = { type: "object", properties: { status: { type: "string" } } };
    expect(shadcnEnumRadioCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE for enum without radio option", () => {
    const rootSchema = {
      type: "object",
      properties: { status: { type: "string", enum: ["a", "b"] } },
    };
    expect(
      shadcnEnumRadioCellTester(controlWithoutRadio, rootSchema, createTesterContext(rootSchema)),
    ).toBe(NOT_APPLICABLE);
  });

  it("should return rank 20 for enum schema with radio option", () => {
    const rootSchema = {
      type: "object",
      properties: { status: { type: "string", enum: ["a", "b"] } },
    };
    expect(shadcnEnumRadioCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      20,
    );
  });
});

describe("ShadcnEnumRadioCell", () => {
  afterEach(() => cleanup());

  it("should render radio group with all options", () => {
    const core = initCore(schema, uischema, { status: "active" });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnEnumRadioCellContext
          schema={{ type: "string", enum: ["pending", "active", "completed"] }}
          uischema={uischema}
          path="status"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const radioGroup = screen.getByRole("radiogroup");
    expect(radioGroup).toBeInTheDocument();

    expect(screen.getByRole("radio", { name: "pending" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "active" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "completed" })).toBeInTheDocument();
  });

  it("should have correct value checked", () => {
    const core = initCore(schema, uischema, { status: "active" });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnEnumRadioCellContext
          schema={{ type: "string", enum: ["pending", "active", "completed"] }}
          uischema={uischema}
          path="status"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    expect(screen.getByRole("radio", { name: "active" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "pending" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "completed" })).not.toBeChecked();
  });

  it("should call handleChange on selection", () => {
    const core = initCore(schema, uischema, { status: "pending" });
    const onChangeData: { data: unknown } = { data: undefined };

    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <TestEmitter
          onChange={({ data }) => {
            onChangeData.data = data;
          }}
        />
        <ShadcnEnumRadioCellContext
          schema={{ type: "string", enum: ["pending", "active", "completed"] }}
          uischema={uischema}
          path="status"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    fireEvent.click(screen.getByRole("radio", { name: "completed" }));

    expect((onChangeData.data as { status: string }).status).toBe("completed");
  });

  it("should be disabled when enabled=false", () => {
    const core = initCore(schema, uischema, {});
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnEnumRadioCellContext
          schema={{ type: "string", enum: ["pending", "active", "completed"] }}
          uischema={uischema}
          path="status"
          enabled={false}
        />
      </JsonFormsStateProvider>,
    );

    expect(screen.getByRole("radio", { name: "pending" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "active" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "completed" })).toBeDisabled();
  });

  it("should have no selection when data is undefined", () => {
    const core = initCore(schema, uischema, {});
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnEnumRadioCellContext
          schema={{ type: "string", enum: ["pending", "active", "completed"] }}
          uischema={uischema}
          path="status"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    expect(screen.getByRole("radio", { name: "pending" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "active" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "completed" })).not.toBeChecked();
  });
});
