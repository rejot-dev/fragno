import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ControlElement } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonFormsStateProvider } from "@jsonforms/react";
import { ShadcnDateCellContext, shadcnDateCellTester } from "./ShadcnDateCell";
import { initCore, TestEmitter, createTesterContext } from "../util/test-utils";

const schema = {
  type: "object",
  properties: {
    eventDate: { type: "string", format: "date" },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/eventDate",
};

describe("shadcnDateCellTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/eventDate",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnDateCellTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnDateCellTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-date schema", () => {
    const rootSchema = { type: "object", properties: { eventDate: { type: "string" } } };
    expect(shadcnDateCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 2 for date format schema", () => {
    const rootSchema = {
      type: "object",
      properties: { eventDate: { type: "string", format: "date" } },
    };
    expect(shadcnDateCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(2);
  });
});

describe("ShadcnDateCell", () => {
  afterEach(() => cleanup());

  it("should render date picker button", () => {
    const core = initCore(schema, uischema, { eventDate: "2024-06-15" });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnDateCellContext
          schema={{ type: "string", format: "date" }}
          uischema={uischema}
          path="eventDate"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const button = screen.getByRole("button");
    expect(button).toBeInTheDocument();
  });

  it("should display formatted date", () => {
    const core = initCore(schema, uischema, { eventDate: "2024-06-15" });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnDateCellContext
          schema={{ type: "string", format: "date" }}
          uischema={uischema}
          path="eventDate"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const button = screen.getByRole("button");
    // Localized string, can't test for exact match
    expect(button).toHaveTextContent(/2024/);
  });

  it("should display placeholder when no date", () => {
    const core = initCore(schema, uischema, {});
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnDateCellContext
          schema={{ type: "string", format: "date" }}
          uischema={uischema}
          path="eventDate"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("Select date");
  });

  it("should handle date selection", async () => {
    const core = initCore(schema, uischema, {});
    const onChangeData: { data: unknown } = { data: undefined };

    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <TestEmitter
          onChange={({ data }) => {
            onChangeData.data = data;
          }}
        />
        <ShadcnDateCellContext
          schema={{ type: "string", format: "date" }}
          uischema={uischema}
          path="eventDate"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const button = screen.getByRole("button");
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByRole("grid")).toBeInTheDocument();
    });

    const gridCells = screen.getAllByRole("gridcell");
    const day10Cell = gridCells.find((cell) => cell.textContent === "10");
    const day10Button = day10Cell?.querySelector("button");
    if (day10Button) {
      fireEvent.click(day10Button);
    }

    await waitFor(() => {
      const data = onChangeData.data as { eventDate?: string };
      expect(data.eventDate).toMatch(/^\d{4}-\d{2}-10$/);
    });
  });

  it("should be disabled when enabled=false", () => {
    const core = initCore(schema, uischema, {});
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnDateCellContext
          schema={{ type: "string", format: "date" }}
          uischema={uischema}
          path="eventDate"
          enabled={false}
        />
      </JsonFormsStateProvider>,
    );

    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
  });
});
