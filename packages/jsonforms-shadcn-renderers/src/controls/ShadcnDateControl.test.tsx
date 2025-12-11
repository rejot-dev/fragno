import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ControlElement, JsonSchema } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonForms } from "@jsonforms/react";
import { shadcnDateControlTester, ShadcnDateControlContext } from "./ShadcnDateControl";
import { createTesterContext } from "../util/test-utils";

const schema: JsonSchema = {
  type: "object",
  properties: {
    birthDate: {
      type: "string",
      format: "date",
      title: "Birth Date",
      description: "Enter your date of birth",
    },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/birthDate",
};

const renderers = [{ tester: shadcnDateControlTester, renderer: ShadcnDateControlContext }];

describe("shadcnDateControlTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/birthDate",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnDateControlTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnDateControlTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-date schema", () => {
    const rootSchema = { type: "object", properties: { birthDate: { type: "string" } } };
    expect(shadcnDateControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE for number schema", () => {
    const rootSchema = { type: "object", properties: { birthDate: { type: "number" } } };
    expect(shadcnDateControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 4 for date format schema", () => {
    const rootSchema = {
      type: "object",
      properties: { birthDate: { type: "string", format: "date" } },
    };
    expect(shadcnDateControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(4);
  });

  it("should return rank 4 when format option is date", () => {
    const rootSchema = { type: "object", properties: { birthDate: { type: "string" } } };
    const controlWithOption: ControlElement = {
      type: "Control",
      scope: "#/properties/birthDate",
      options: { format: "date" },
    };
    expect(
      shadcnDateControlTester(controlWithOption, rootSchema, createTesterContext(rootSchema)),
    ).toBe(4);
  });
});

describe("ShadcnDateControl", () => {
  afterEach(() => cleanup());

  it("should render date picker button with label", () => {
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ birthDate: "2000-01-15" }}
        renderers={renderers}
      />,
    );

    const button = screen.getByRole("button");
    expect(button).toBeInTheDocument();
    expect(screen.getByText("Birth Date")).toBeInTheDocument();
  });

  it("should display formatted date when data is provided", () => {
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ birthDate: "2000-01-15" }}
        renderers={renderers}
      />,
    );

    const button = screen.getByRole("button");
    // This is a localized text content, cannot test the exact format
    expect(button).toHaveTextContent(/2000/);
  });

  it("should display placeholder when no date is selected", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("Select date");
  });

  it("should render description when provided", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    expect(screen.getByText("Enter your date of birth")).toBeInTheDocument();
  });

  it("should open calendar popover on button click", async () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const button = screen.getByRole("button");
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByRole("grid")).toBeInTheDocument();
    });
  });

  it("should handle date selection", async () => {
    let changedData: unknown;
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{}}
        renderers={renderers}
        onChange={({ data }) => {
          changedData = data;
        }}
      />,
    );

    const button = screen.getByRole("button");
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByRole("grid")).toBeInTheDocument();
    });

    const gridCells = screen.getAllByRole("gridcell");
    const day15Cell = gridCells.find((cell) => cell.textContent === "15");
    const day15Button = day15Cell?.querySelector("button");
    if (day15Button) {
      fireEvent.click(day15Button);
    }

    await waitFor(() => {
      const data = changedData as { birthDate?: string };
      expect(data.birthDate).toMatch(/^\d{4}-\d{2}-15$/);
    });
  });

  it("should be enabled by default", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const button = screen.getByRole("button");
    expect(button).not.toBeDisabled();
  });
});
