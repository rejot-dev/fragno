import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ControlElement, JsonSchema } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonForms } from "@jsonforms/react";
import { shadcnEnumControlTester, ShadcnEnumControlContext } from "./ShadcnEnumControl";
import { createTesterContext } from "../util/test-utils";

const schema: JsonSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["pending", "active", "completed"],
      title: "Status",
      description: "Select the current status",
    },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/status",
};

const renderers = [{ tester: shadcnEnumControlTester, renderer: ShadcnEnumControlContext }];

describe("shadcnEnumControlTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/status",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnEnumControlTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnEnumControlTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-enum schema", () => {
    const rootSchema = { type: "object", properties: { status: { type: "string" } } };
    expect(shadcnEnumControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 2 for enum schema", () => {
    const rootSchema = {
      type: "object",
      properties: { status: { type: "string", enum: ["a", "b"] } },
    };
    expect(shadcnEnumControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(2);
  });
});

describe("ShadcnEnumControl", () => {
  afterEach(() => cleanup());

  it("should render select with label", () => {
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ status: "active" }}
        renderers={renderers}
      />,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent("active");
    expect(screen.getByText("Status")).toBeInTheDocument();
  });

  it("should render description when provided", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    expect(screen.getByText("Select the current status")).toBeInTheDocument();
  });

  it("should display placeholder when no value is selected", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("Select an option");
  });

  it("should show all enum options when opened", async () => {
    // Mock scrollIntoView for Radix UI
    Element.prototype.scrollIntoView = vi.fn();

    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ status: "pending" }}
        renderers={renderers}
      />,
    );

    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });

    expect(screen.getByRole("option", { name: "pending" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "active" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "completed" })).toBeInTheDocument();
  });

  it("should be enabled by default", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const trigger = screen.getByRole("combobox");
    expect(trigger).not.toBeDisabled();
  });

  it("should not display validation error before field is touched", () => {
    const requiredSchema: JsonSchema = {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "active", "completed"],
        },
      },
      required: ["status"],
    };

    render(
      <JsonForms
        schema={requiredSchema}
        uischema={uischema}
        data={{}}
        renderers={renderers}
        validationMode="ValidateAndShow"
      />,
    );

    // Validation error should NOT show until field is touched
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("should display validation error when field has a value (pre-filled)", () => {
    const requiredSchema: JsonSchema = {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "active", "completed"],
          minLength: 100, // Force validation error even with a value
        },
      },
      required: ["status"],
    };

    render(
      <JsonForms
        schema={requiredSchema}
        uischema={uischema}
        data={{ status: "active" }}
        renderers={renderers}
        validationMode="ValidateAndShow"
      />,
    );

    // Validation error SHOULD show when field has a value (pre-filled forms)
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
