import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ControlElement } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonFormsStateProvider } from "@jsonforms/react";
import { ShadcnOneOfEnumCellContext, shadcnOneOfEnumCellTester } from "./ShadcnOneOfEnumCell";
import { initCore, TestEmitter, createTesterContext } from "../util/test-utils";

const schema = {
  type: "object",
  properties: {
    country: {
      oneOf: [
        { const: "us", title: "United States" },
        { const: "uk", title: "United Kingdom" },
        { const: "de", title: "Germany" },
      ],
    },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/country",
};

describe("shadcnOneOfEnumCellTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/country",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnOneOfEnumCellTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnOneOfEnumCellTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for regular enum schema", () => {
    const rootSchema = {
      type: "object",
      properties: { country: { type: "string", enum: ["us", "uk"] } },
    };
    expect(shadcnOneOfEnumCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
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
    expect(shadcnOneOfEnumCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 2 for oneOf with const schema", () => {
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
    expect(shadcnOneOfEnumCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(2);
  });
});

describe("ShadcnOneOfEnumCell", () => {
  afterEach(() => cleanup());

  it("should render select with value", async () => {
    const core = initCore(schema, uischema, { country: "uk" });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnOneOfEnumCellContext
          schema={schema.properties.country}
          uischema={uischema}
          path="country"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger).toBeInTheDocument();
    // The displayed text should be the title from oneOf
    expect(trigger).toHaveTextContent("United Kingdom");
  });

  it("should render placeholder when no value", () => {
    const core = initCore(schema, uischema, {});
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnOneOfEnumCellContext
          schema={schema.properties.country}
          uischema={uischema}
          path="country"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("Select an option");
  });

  it("should show all options with titles when opened", async () => {
    // Mock scrollIntoView for Radix UI
    Element.prototype.scrollIntoView = vi.fn();

    const core = initCore(schema, uischema, { country: "us" });

    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnOneOfEnumCellContext
          schema={schema.properties.country}
          uischema={uischema}
          path="country"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });

    // Should display titles, not const values
    expect(screen.getByRole("option", { name: "United States" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "United Kingdom" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Germany" })).toBeInTheDocument();
  });

  it("should call handleChange on selection", async () => {
    Element.prototype.scrollIntoView = vi.fn();

    const core = initCore(schema, uischema, { country: "us" });
    const onChangeData: { data: unknown } = { data: undefined };

    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <TestEmitter
          onChange={({ data }) => {
            onChangeData.data = data;
          }}
        />
        <ShadcnOneOfEnumCellContext
          schema={schema.properties.country}
          uischema={uischema}
          path="country"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("option", { name: "Germany" }));

    expect((onChangeData.data as { country: string }).country).toBe("de");
  });

  it("should be disabled when enabled=false", () => {
    const core = initCore(schema, uischema, {});
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnOneOfEnumCellContext
          schema={schema.properties.country}
          uischema={uischema}
          path="country"
          enabled={false}
        />
      </JsonFormsStateProvider>,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger).toBeDisabled();
  });
});
