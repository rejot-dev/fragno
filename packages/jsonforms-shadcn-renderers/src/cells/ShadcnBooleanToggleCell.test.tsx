import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ControlElement } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonFormsStateProvider } from "@jsonforms/react";
import {
  ShadcnBooleanToggleCellContext,
  shadcnBooleanToggleCellTester,
} from "./ShadcnBooleanToggleCell";
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
  options: {
    toggle: true,
  },
};

describe("shadcnBooleanToggleCellTester", () => {
  const controlWithToggle: ControlElement = {
    type: "Control",
    scope: "#/properties/foo",
    options: { toggle: true },
  };

  const controlWithoutToggle: ControlElement = {
    type: "Control",
    scope: "#/properties/foo",
  };

  const controlWithToggleFalse: ControlElement = {
    type: "Control",
    scope: "#/properties/foo",
    options: { toggle: false },
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnBooleanToggleCellTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnBooleanToggleCellTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE when toggle option is not set", () => {
    const rootSchema = { type: "object", properties: { foo: { type: "boolean" } } };
    expect(
      shadcnBooleanToggleCellTester(
        controlWithoutToggle,
        rootSchema,
        createTesterContext(rootSchema),
      ),
    ).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE when toggle option is false", () => {
    const rootSchema = { type: "object", properties: { foo: { type: "boolean" } } };
    expect(
      shadcnBooleanToggleCellTester(
        controlWithToggleFalse,
        rootSchema,
        createTesterContext(rootSchema),
      ),
    ).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-boolean schema with toggle", () => {
    const rootSchema = { type: "object", properties: { foo: { type: "string" } } };
    expect(
      shadcnBooleanToggleCellTester(controlWithToggle, rootSchema, createTesterContext(rootSchema)),
    ).toBe(NOT_APPLICABLE);
  });

  it("should return rank 3 for boolean schema with toggle: true", () => {
    const rootSchema = { type: "object", properties: { foo: { type: "boolean" } } };
    expect(
      shadcnBooleanToggleCellTester(controlWithToggle, rootSchema, createTesterContext(rootSchema)),
    ).toBe(3);
  });
});

describe("ShadcnBooleanToggleCell", () => {
  afterEach(() => cleanup());

  it("should render switch with checked=true when data is true", () => {
    const core = initCore(schema, uischema, { foo: true });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnBooleanToggleCellContext
          schema={{ type: "boolean" }}
          uischema={uischema}
          path="foo"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const switchEl = screen.getByRole("switch");
    expect(switchEl).toBeInTheDocument();
    expect(switchEl).toHaveAttribute("data-state", "checked");
  });

  it("should render switch with checked=false when data is false", () => {
    const core = initCore(schema, uischema, { foo: false });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnBooleanToggleCellContext
          schema={{ type: "boolean" }}
          uischema={uischema}
          path="foo"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const switchEl = screen.getByRole("switch");
    expect(switchEl).toHaveAttribute("data-state", "unchecked");
  });

  it("should handle undefined/null data as unchecked", () => {
    const core = initCore(schema, uischema, { foo: undefined });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnBooleanToggleCellContext
          schema={{ type: "boolean" }}
          uischema={uischema}
          path="foo"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const switchEl = screen.getByRole("switch");
    expect(switchEl).toHaveAttribute("data-state", "unchecked");
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
        <ShadcnBooleanToggleCellContext
          schema={{ type: "boolean" }}
          uischema={uischema}
          path="foo"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const switchEl = screen.getByRole("switch");
    fireEvent.click(switchEl);

    expect((onChangeData.data as { foo: boolean }).foo).toBe(false);
  });

  it("should be disabled when enabled=false", () => {
    const core = initCore(schema, uischema, { foo: true });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnBooleanToggleCellContext
          schema={{ type: "boolean" }}
          uischema={uischema}
          path="foo"
          enabled={false}
        />
      </JsonFormsStateProvider>,
    );

    const switchEl = screen.getByRole("switch");
    expect(switchEl).toBeDisabled();
  });

  it("should be enabled by default when enabled=true", () => {
    const core = initCore(schema, uischema, { foo: true });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnBooleanToggleCellContext
          schema={{ type: "boolean" }}
          uischema={uischema}
          path="foo"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const switchEl = screen.getByRole("switch");
    expect(switchEl).not.toBeDisabled();
  });

  it("should apply provided id", () => {
    const core = initCore(schema, uischema, { foo: true });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnBooleanToggleCellContext
          schema={{ type: "boolean" }}
          uischema={uischema}
          path="foo"
          enabled={true}
          id="my-switch"
        />
      </JsonFormsStateProvider>,
    );

    const switchEl = screen.getByRole("switch");
    expect(switchEl).toHaveAttribute("id", "my-switch");
  });
});
