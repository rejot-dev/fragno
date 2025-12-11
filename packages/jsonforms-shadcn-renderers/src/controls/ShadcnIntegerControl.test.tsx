import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ControlElement, JsonSchema } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonForms } from "@jsonforms/react";
import { shadcnIntegerControlTester, ShadcnIntegerControlContext } from "./ShadcnIntegerControl";
import { createTesterContext } from "../util/test-utils";

const schema: JsonSchema = {
  type: "object",
  properties: {
    age: {
      type: "integer",
      title: "Age",
      description: "Enter your age",
    },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/age",
};

const renderers = [{ tester: shadcnIntegerControlTester, renderer: ShadcnIntegerControlContext }];

describe("shadcnIntegerControlTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/age",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnIntegerControlTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnIntegerControlTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-integer schema", () => {
    const rootSchema = { type: "object", properties: { age: { type: "string" } } };
    expect(shadcnIntegerControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE for number schema", () => {
    const rootSchema = { type: "object", properties: { age: { type: "number" } } };
    expect(shadcnIntegerControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 4 for integer schema", () => {
    const rootSchema = { type: "object", properties: { age: { type: "integer" } } };
    expect(shadcnIntegerControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      4,
    );
  });
});

describe("ShadcnIntegerControl", () => {
  afterEach(() => cleanup());

  it("should render input with label", () => {
    render(
      <JsonForms schema={schema} uischema={uischema} data={{ age: 25 }} renderers={renderers} />,
    );

    const input = screen.getByRole("spinbutton");
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue(25);
    expect(screen.getByText("Age")).toBeInTheDocument();
  });

  it("should render description when provided", () => {
    render(
      <JsonForms schema={schema} uischema={uischema} data={{ age: 25 }} renderers={renderers} />,
    );

    expect(screen.getByText("Enter your age")).toBeInTheDocument();
  });

  it("should handle data change", async () => {
    let changedData: unknown;
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ age: 0 }}
        renderers={renderers}
        onChange={({ data }) => {
          changedData = data;
        }}
      />,
    );

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "30" } });

    await waitFor(() => {
      expect((changedData as { age: number }).age).toBe(30);
    });
  });

  it("should handle undefined data as empty", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const input = screen.getByRole("spinbutton");
    expect(input).toHaveValue(null);
  });

  it("should be enabled by default", () => {
    render(
      <JsonForms schema={schema} uischema={uischema} data={{ age: 25 }} renderers={renderers} />,
    );

    const input = screen.getByRole("spinbutton");
    expect(input).not.toBeDisabled();
  });

  it("should have step=1 for integers", () => {
    render(
      <JsonForms schema={schema} uischema={uischema} data={{ age: 25 }} renderers={renderers} />,
    );

    const input = screen.getByRole("spinbutton");
    expect(input).toHaveAttribute("step", "1");
  });
});
