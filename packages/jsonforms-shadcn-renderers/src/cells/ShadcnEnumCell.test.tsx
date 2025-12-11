import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ControlElement } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonFormsStateProvider } from "@jsonforms/react";
import { ShadcnEnumCellContext, shadcnEnumCellTester } from "./ShadcnEnumCell";
import { initCore, createTesterContext } from "../util/test-utils";

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
};

describe("shadcnEnumCellTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/status",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnEnumCellTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnEnumCellTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-enum schema", () => {
    const rootSchema = { type: "object", properties: { status: { type: "string" } } };
    expect(shadcnEnumCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 2 for enum schema", () => {
    const rootSchema = {
      type: "object",
      properties: { status: { type: "string", enum: ["a", "b"] } },
    };
    expect(shadcnEnumCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(2);
  });
});

describe("ShadcnEnumCell", () => {
  afterEach(() => cleanup());

  it("should render select with value", async () => {
    const core = initCore(schema, uischema, { status: "active" });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnEnumCellContext
          schema={{ type: "string", enum: ["pending", "active", "completed"] }}
          uischema={uischema}
          path="status"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent("active");
  });

  it("should render placeholder when no value", () => {
    const core = initCore(schema, uischema, {});
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnEnumCellContext
          schema={{ type: "string", enum: ["pending", "active", "completed"] }}
          uischema={uischema}
          path="status"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("Select an option");
  });

  it("should show all enum options when opened", async () => {
    // Mock scrollIntoView for Radix UI
    Element.prototype.scrollIntoView = vi.fn();

    const core = initCore(schema, uischema, { status: "pending" });

    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnEnumCellContext
          schema={{ type: "string", enum: ["pending", "active", "completed"] }}
          uischema={uischema}
          path="status"
          enabled={true}
        />
      </JsonFormsStateProvider>,
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

  it("should be disabled when enabled=false", () => {
    const core = initCore(schema, uischema, {});
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnEnumCellContext
          schema={{ type: "string", enum: ["pending", "active", "completed"] }}
          uischema={uischema}
          path="status"
          enabled={false}
        />
      </JsonFormsStateProvider>,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger).toBeDisabled();
  });
});
