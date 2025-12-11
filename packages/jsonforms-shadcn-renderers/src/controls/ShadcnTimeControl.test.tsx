import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ControlElement, JsonSchema } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonForms } from "@jsonforms/react";
import { shadcnTimeControlTester, ShadcnTimeControlContext } from "./ShadcnTimeControl";
import { createTesterContext } from "../util/test-utils";

const schema: JsonSchema = {
  type: "object",
  properties: {
    startTime: {
      type: "string",
      format: "time",
      title: "Start Time",
      description: "When does your shift start?",
    },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/startTime",
};

const renderers = [{ tester: shadcnTimeControlTester, renderer: ShadcnTimeControlContext }];

describe("shadcnTimeControlTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/startTime",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnTimeControlTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnTimeControlTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-time schema", () => {
    const rootSchema = { type: "object", properties: { startTime: { type: "string" } } };
    expect(shadcnTimeControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE for date format schema", () => {
    const rootSchema = {
      type: "object",
      properties: { startTime: { type: "string", format: "date" } },
    };
    expect(shadcnTimeControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 4 for time format schema", () => {
    const rootSchema = {
      type: "object",
      properties: { startTime: { type: "string", format: "time" } },
    };
    expect(shadcnTimeControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(4);
  });

  it("should return rank 4 when format option is time", () => {
    const rootSchema = { type: "object", properties: { startTime: { type: "string" } } };
    const controlWithOption: ControlElement = {
      type: "Control",
      scope: "#/properties/startTime",
      options: { format: "time" },
    };
    expect(
      shadcnTimeControlTester(controlWithOption, rootSchema, createTesterContext(rootSchema)),
    ).toBe(4);
  });
});

describe("ShadcnTimeControl", () => {
  afterEach(() => cleanup());

  const getTimeInput = () => document.querySelector('input[type="time"]') as HTMLInputElement;

  it("should render time input with label", () => {
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ startTime: "09:00:00" }}
        renderers={renderers}
      />,
    );

    const input = getTimeInput();
    expect(input).toBeInTheDocument();
    // Native time input displays HH:mm even when data is HH:mm:ss
    expect(input).toHaveValue("09:00");
    expect(screen.getByText("Start Time")).toBeInTheDocument();
  });

  it("should render description when provided", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    expect(screen.getByText("When does your shift start?")).toBeInTheDocument();
  });

  it("should handle data change with seconds appended", async () => {
    let changedData: unknown;
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ startTime: "" }}
        renderers={renderers}
        onChange={({ data }) => {
          changedData = data;
        }}
      />,
    );

    const input = getTimeInput();
    fireEvent.change(input, { target: { value: "14:30" } });

    await waitFor(() => {
      // Should output HH:mm:ss format for JSON Schema compliance
      expect((changedData as { startTime: string }).startTime).toBe("14:30:00");
    });
  });

  it("should handle undefined data as empty string", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const input = getTimeInput();
    expect(input).toHaveValue("");
  });

  it("should be enabled by default", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const input = getTimeInput();
    expect(input).not.toBeDisabled();
  });
});
