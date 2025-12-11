import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ControlElement, JsonSchema } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonForms } from "@jsonforms/react";
import { shadcnDateTimeControlTester, ShadcnDateTimeControlContext } from "./ShadcnDateTimeControl";
import { createTesterContext } from "../util/test-utils";

const schema: JsonSchema = {
  type: "object",
  properties: {
    appointmentTime: {
      type: "string",
      format: "date-time",
      title: "Appointment",
      description: "Select your appointment date and time",
    },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/appointmentTime",
};

const renderers = [{ tester: shadcnDateTimeControlTester, renderer: ShadcnDateTimeControlContext }];

describe("shadcnDateTimeControlTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/appointmentTime",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnDateTimeControlTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnDateTimeControlTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-datetime schema", () => {
    const rootSchema = { type: "object", properties: { appointmentTime: { type: "string" } } };
    expect(shadcnDateTimeControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE for date format schema", () => {
    const rootSchema = {
      type: "object",
      properties: { appointmentTime: { type: "string", format: "date" } },
    };
    expect(shadcnDateTimeControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE for time format schema", () => {
    const rootSchema = {
      type: "object",
      properties: { appointmentTime: { type: "string", format: "time" } },
    };
    expect(shadcnDateTimeControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 4 for date-time format schema", () => {
    const rootSchema = {
      type: "object",
      properties: { appointmentTime: { type: "string", format: "date-time" } },
    };
    expect(shadcnDateTimeControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      4,
    );
  });

  it("should return rank 4 when format option is date-time", () => {
    const rootSchema = { type: "object", properties: { appointmentTime: { type: "string" } } };
    const controlWithOption: ControlElement = {
      type: "Control",
      scope: "#/properties/appointmentTime",
      options: { format: "date-time" },
    };
    expect(
      shadcnDateTimeControlTester(controlWithOption, rootSchema, createTesterContext(rootSchema)),
    ).toBe(4);
  });
});

describe("ShadcnDateTimeControl", () => {
  afterEach(() => cleanup());

  it("should render datetime picker button with label", () => {
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ appointmentTime: "2024-06-15T14:30:00.000Z" }}
        renderers={renderers}
      />,
    );

    const button = screen.getByRole("button");
    expect(button).toBeInTheDocument();
    expect(screen.getByText("Appointment")).toBeInTheDocument();
  });

  it("should display formatted datetime when data is provided", () => {
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ appointmentTime: "2024-06-15T14:30:00.000Z" }}
        renderers={renderers}
      />,
    );

    const button = screen.getByRole("button");
    // Localized date, can't match exactly
    expect(button).toHaveTextContent(/2024/);
  });

  it("should display placeholder when no datetime is selected", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("Select date");
  });

  it("should render description when provided", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    expect(screen.getByText("Select your appointment date and time")).toBeInTheDocument();
  });

  it("should open calendar popover on button click", async () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const button = screen.getByRole("button");
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByRole("grid")).toBeInTheDocument();
    });
  });

  it("should show time input in popover", async () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const button = screen.getByRole("button");
    fireEvent.click(button);

    await waitFor(() => {
      const timeInput = document.querySelector('input[type="time"]');
      expect(timeInput).toBeInTheDocument();
    });
  });

  it("should be enabled by default", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const button = screen.getByRole("button");
    expect(button).not.toBeDisabled();
  });
});
