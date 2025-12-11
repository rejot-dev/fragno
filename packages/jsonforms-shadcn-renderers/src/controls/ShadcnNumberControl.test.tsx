import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ControlElement, JsonSchema } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonForms } from "@jsonforms/react";
import { shadcnNumberControlTester, ShadcnNumberControlContext } from "./ShadcnNumberControl";
import { createTesterContext } from "../util/test-utils";

const schema: JsonSchema = {
  type: "object",
  properties: {
    price: {
      type: "number",
      title: "Price",
      description: "Enter the price",
    },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/price",
};

const renderers = [{ tester: shadcnNumberControlTester, renderer: ShadcnNumberControlContext }];

describe("shadcnNumberControlTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/price",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnNumberControlTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnNumberControlTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-number schema", () => {
    const rootSchema = { type: "object", properties: { price: { type: "string" } } };
    expect(shadcnNumberControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE for integer schema", () => {
    const rootSchema = { type: "object", properties: { price: { type: "integer" } } };
    expect(shadcnNumberControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 4 for number schema", () => {
    const rootSchema = { type: "object", properties: { price: { type: "number" } } };
    expect(shadcnNumberControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(4);
  });
});

describe("ShadcnNumberControl", () => {
  afterEach(() => cleanup());

  it("should render input with label", () => {
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ price: 19.99 }}
        renderers={renderers}
      />,
    );

    const input = screen.getByRole("spinbutton");
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue(19.99);
    expect(screen.getByText("Price")).toBeInTheDocument();
  });

  it("should render description when provided", () => {
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ price: 19.99 }}
        renderers={renderers}
      />,
    );

    expect(screen.getByText("Enter the price")).toBeInTheDocument();
  });

  it("should handle data change", async () => {
    let changedData: unknown;
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ price: 0 }}
        renderers={renderers}
        onChange={({ data }) => {
          changedData = data;
        }}
      />,
    );

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "29.99" } });

    await waitFor(() => {
      expect((changedData as { price: number }).price).toBe(29.99);
    });
  });

  it("should handle undefined data as empty", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const input = screen.getByRole("spinbutton");
    expect(input).toHaveValue(null);
  });

  it("should be enabled by default", () => {
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ price: 19.99 }}
        renderers={renderers}
      />,
    );

    const input = screen.getByRole("spinbutton");
    expect(input).not.toBeDisabled();
  });

  it("should handle decimal values", async () => {
    let changedData: unknown;
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ price: 0 }}
        renderers={renderers}
        onChange={({ data }) => {
          changedData = data;
        }}
      />,
    );

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "3.14159" } });

    await waitFor(() => {
      expect((changedData as { price: number }).price).toBe(3.14159);
    });
  });
});
