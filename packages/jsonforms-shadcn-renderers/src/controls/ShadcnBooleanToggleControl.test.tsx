import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ControlElement, JsonSchema } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonForms } from "@jsonforms/react";
import {
  shadcnBooleanToggleControlTester,
  ShadcnBooleanToggleControlContext,
} from "./ShadcnBooleanToggleControl";
import { createTesterContext } from "../util/test-utils";

const schema: JsonSchema = {
  type: "object",
  properties: {
    foo: {
      type: "boolean",
      title: "Test Label",
      description: "Test description",
    },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/foo",
  options: {
    toggle: true,
  },
};

const renderers = [
  { tester: shadcnBooleanToggleControlTester, renderer: ShadcnBooleanToggleControlContext },
];

describe("shadcnBooleanToggleControlTester", () => {
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
    expect(shadcnBooleanToggleControlTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnBooleanToggleControlTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE when toggle option is not set", () => {
    const rootSchema = { type: "object", properties: { foo: { type: "boolean" } } };
    expect(
      shadcnBooleanToggleControlTester(
        controlWithoutToggle,
        rootSchema,
        createTesterContext(rootSchema),
      ),
    ).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE when toggle option is false", () => {
    const rootSchema = { type: "object", properties: { foo: { type: "boolean" } } };
    expect(
      shadcnBooleanToggleControlTester(
        controlWithToggleFalse,
        rootSchema,
        createTesterContext(rootSchema),
      ),
    ).toBe(NOT_APPLICABLE);
  });

  it("should return rank 3 for boolean schema with toggle: true", () => {
    const rootSchema = { type: "object", properties: { foo: { type: "boolean" } } };
    expect(
      shadcnBooleanToggleControlTester(
        controlWithToggle,
        rootSchema,
        createTesterContext(rootSchema),
      ),
    ).toBe(3);
  });
});

describe("ShadcnBooleanToggleControl", () => {
  afterEach(() => cleanup());

  it("should render switch with label", () => {
    render(
      <JsonForms schema={schema} uischema={uischema} data={{ foo: true }} renderers={renderers} />,
    );

    const switchEl = screen.getByRole("switch");
    expect(switchEl).toBeInTheDocument();
    expect(switchEl).toHaveAttribute("data-state", "checked");
    expect(screen.getByText("Test Label")).toBeInTheDocument();
  });

  it("should render switch unchecked when data is false", () => {
    render(
      <JsonForms schema={schema} uischema={uischema} data={{ foo: false }} renderers={renderers} />,
    );

    const switchEl = screen.getByRole("switch");
    expect(switchEl).toHaveAttribute("data-state", "unchecked");
  });

  it("should render description when provided", () => {
    render(
      <JsonForms schema={schema} uischema={uischema} data={{ foo: true }} renderers={renderers} />,
    );

    expect(screen.getByText("Test description")).toBeInTheDocument();
  });

  it("should handle data change when clicked", async () => {
    let changedData: unknown;
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ foo: true }}
        renderers={renderers}
        onChange={({ data }) => {
          changedData = data;
        }}
      />,
    );

    const switchEl = screen.getByRole("switch");
    fireEvent.click(switchEl);

    await waitFor(() => {
      expect((changedData as { foo: boolean }).foo).toBe(false);
    });
  });

  it("should handle undefined data as unchecked", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const switchEl = screen.getByRole("switch");
    expect(switchEl).toHaveAttribute("data-state", "unchecked");
  });

  it("should be enabled by default", () => {
    render(
      <JsonForms schema={schema} uischema={uischema} data={{ foo: true }} renderers={renderers} />,
    );

    const switchEl = screen.getByRole("switch");
    expect(switchEl).not.toBeDisabled();
  });
});
