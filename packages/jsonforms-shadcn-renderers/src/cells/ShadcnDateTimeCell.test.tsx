import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ControlElement } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonFormsStateProvider } from "@jsonforms/react";
import { ShadcnDateTimeCellContext, shadcnDateTimeCellTester } from "./ShadcnDateTimeCell";
import { initCore, createTesterContext } from "../util/test-utils";

const schema = {
  type: "object",
  properties: {
    appointmentTime: { type: "string", format: "date-time" },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/appointmentTime",
};

describe("shadcnDateTimeCellTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/appointmentTime",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnDateTimeCellTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnDateTimeCellTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-datetime schema", () => {
    const rootSchema = { type: "object", properties: { appointmentTime: { type: "string" } } };
    expect(shadcnDateTimeCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 2 for date-time format schema", () => {
    const rootSchema = {
      type: "object",
      properties: { appointmentTime: { type: "string", format: "date-time" } },
    };
    expect(shadcnDateTimeCellTester(control, rootSchema, createTesterContext(rootSchema))).toBe(2);
  });
});

describe("ShadcnDateTimeCell", () => {
  afterEach(() => cleanup());

  it("should render datetime picker button", () => {
    const core = initCore(schema, uischema, { appointmentTime: "2024-06-15T14:30:00.000Z" });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnDateTimeCellContext
          schema={{ type: "string", format: "date-time" }}
          uischema={uischema}
          path="appointmentTime"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const button = screen.getByRole("button");
    expect(button).toBeInTheDocument();
  });

  it("should display formatted datetime", () => {
    const core = initCore(schema, uischema, { appointmentTime: "2024-06-15T14:30:00.000Z" });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnDateTimeCellContext
          schema={{ type: "string", format: "date-time" }}
          uischema={uischema}
          path="appointmentTime"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const button = screen.getByRole("button");
    // Localized date, can't match exactly
    expect(button).toHaveTextContent(/2024/);
  });

  it("should display placeholder when no datetime", () => {
    const core = initCore(schema, uischema, {});
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnDateTimeCellContext
          schema={{ type: "string", format: "date-time" }}
          uischema={uischema}
          path="appointmentTime"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("Select date");
  });

  it("should open popover on click", async () => {
    const core = initCore(schema, uischema, {});
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnDateTimeCellContext
          schema={{ type: "string", format: "date-time" }}
          uischema={uischema}
          path="appointmentTime"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    const button = screen.getByRole("button");
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByRole("grid")).toBeInTheDocument();
    });
  });

  it("should be disabled when enabled=false", () => {
    const core = initCore(schema, uischema, {});
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnDateTimeCellContext
          schema={{ type: "string", format: "date-time" }}
          uischema={uischema}
          path="appointmentTime"
          enabled={false}
        />
      </JsonFormsStateProvider>,
    );

    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
  });
});
