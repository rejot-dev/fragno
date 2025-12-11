import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ControlElement, JsonSchema } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonForms } from "@jsonforms/react";
import {
  shadcnOneOfEnumControlTester,
  ShadcnOneOfEnumControlContext,
} from "./ShadcnOneOfEnumControl";
import { createTesterContext } from "../util/test-utils";

const schema: JsonSchema = {
  type: "object",
  properties: {
    country: {
      oneOf: [
        { const: "us", title: "United States" },
        { const: "uk", title: "United Kingdom" },
        { const: "de", title: "Germany" },
      ],
      title: "Country",
      description: "Select your country",
    },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/country",
};

const renderers = [
  { tester: shadcnOneOfEnumControlTester, renderer: ShadcnOneOfEnumControlContext },
];

describe("shadcnOneOfEnumControlTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/country",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnOneOfEnumControlTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnOneOfEnumControlTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for regular enum schema", () => {
    const rootSchema = {
      type: "object",
      properties: { country: { type: "string", enum: ["us", "uk"] } },
    };
    expect(shadcnOneOfEnumControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE for oneOf without const", () => {
    const rootSchema = {
      type: "object",
      properties: {
        country: {
          oneOf: [{ type: "string" }, { type: "number" }],
        },
      },
    };
    expect(shadcnOneOfEnumControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 5 for oneOf with const schema", () => {
    const rootSchema = {
      type: "object",
      properties: {
        country: {
          oneOf: [
            { const: "us", title: "United States" },
            { const: "uk", title: "United Kingdom" },
          ],
        },
      },
    };
    expect(shadcnOneOfEnumControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      5,
    );
  });
});

describe("ShadcnOneOfEnumControl", () => {
  afterEach(() => cleanup());

  it("should render select with label", () => {
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ country: "uk" }}
        renderers={renderers}
      />,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent("United Kingdom");
    expect(screen.getByText("Country")).toBeInTheDocument();
  });

  it("should render description when provided", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    expect(screen.getByText("Select your country")).toBeInTheDocument();
  });

  it("should display placeholder when no value is selected", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("Select an option");
  });

  it("should show all options with titles when opened", async () => {
    // Mock scrollIntoView for Radix UI
    Element.prototype.scrollIntoView = vi.fn();

    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ country: "us" }}
        renderers={renderers}
      />,
    );

    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });

    expect(screen.getByRole("option", { name: "United States" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "United Kingdom" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Germany" })).toBeInTheDocument();
  });

  it("should be enabled by default", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const trigger = screen.getByRole("combobox");
    expect(trigger).not.toBeDisabled();
  });
});
