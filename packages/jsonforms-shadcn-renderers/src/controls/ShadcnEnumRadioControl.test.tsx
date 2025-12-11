import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ControlElement, JsonSchema } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonForms } from "@jsonforms/react";
import {
  shadcnEnumRadioControlTester,
  ShadcnEnumRadioControlContext,
} from "./ShadcnEnumRadioControl";
import { createTesterContext } from "../util/test-utils";

const schema: JsonSchema = {
  type: "object",
  properties: {
    priority: {
      type: "string",
      enum: ["low", "medium", "high"],
      title: "Priority",
      description: "Select the priority level",
    },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/priority",
  options: {
    format: "radio",
  },
};

const renderers = [
  { tester: shadcnEnumRadioControlTester, renderer: ShadcnEnumRadioControlContext },
];

describe("shadcnEnumRadioControlTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/priority",
    options: {
      format: "radio",
    },
  };

  const controlWithoutRadio: ControlElement = {
    type: "Control",
    scope: "#/properties/priority",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnEnumRadioControlTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnEnumRadioControlTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-enum schema", () => {
    const rootSchema = { type: "object", properties: { priority: { type: "string" } } };
    expect(shadcnEnumRadioControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE for enum without radio option", () => {
    const rootSchema = {
      type: "object",
      properties: { priority: { type: "string", enum: ["a", "b"] } },
    };
    expect(
      shadcnEnumRadioControlTester(
        controlWithoutRadio,
        rootSchema,
        createTesterContext(rootSchema),
      ),
    ).toBe(NOT_APPLICABLE);
  });

  it("should return rank 20 for enum schema with radio option", () => {
    const rootSchema = {
      type: "object",
      properties: { priority: { type: "string", enum: ["a", "b"] } },
    };
    expect(shadcnEnumRadioControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      20,
    );
  });
});

describe("ShadcnEnumRadioControl", () => {
  afterEach(() => cleanup());

  it("should render radio group with label", () => {
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ priority: "medium" }}
        renderers={renderers}
      />,
    );

    expect(screen.getByText("Priority")).toBeInTheDocument();
    const radioGroup = screen.getByRole("radiogroup");
    expect(radioGroup).toBeInTheDocument();
  });

  it("should render all enum options as radio buttons", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    expect(screen.getByRole("radio", { name: "low" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "medium" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "high" })).toBeInTheDocument();
  });

  it("should render description when provided", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    expect(screen.getByText("Select the priority level")).toBeInTheDocument();
  });

  it("should have correct value checked", () => {
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ priority: "high" }}
        renderers={renderers}
      />,
    );

    expect(screen.getByRole("radio", { name: "high" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "low" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "medium" })).not.toBeChecked();
  });

  it("should have no selection when data is undefined", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    expect(screen.getByRole("radio", { name: "low" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "medium" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "high" })).not.toBeChecked();
  });

  it("should be enabled by default", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    expect(screen.getByRole("radio", { name: "low" })).not.toBeDisabled();
    expect(screen.getByRole("radio", { name: "medium" })).not.toBeDisabled();
    expect(screen.getByRole("radio", { name: "high" })).not.toBeDisabled();
  });
});
