import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ControlElement, JsonSchema } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonForms } from "@jsonforms/react";
import { shadcnTextControlTester, ShadcnTextControlContext } from "./ShadcnTextControl";
import { createTesterContext } from "../util/test-utils";

const schema: JsonSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      title: "Name",
      description: "Enter your name",
    },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/name",
};

const renderers = [{ tester: shadcnTextControlTester, renderer: ShadcnTextControlContext }];

describe("shadcnTextControlTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/name",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnTextControlTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnTextControlTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-string schema", () => {
    const rootSchema = { type: "object", properties: { name: { type: "number" } } };
    expect(shadcnTextControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 1 for string schema", () => {
    const rootSchema = { type: "object", properties: { name: { type: "string" } } };
    expect(shadcnTextControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(1);
  });
});

describe("ShadcnTextControl", () => {
  afterEach(() => cleanup());

  it("should render input with label", () => {
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ name: "John" }}
        renderers={renderers}
      />,
    );

    const input = screen.getByRole("textbox");
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue("John");
    expect(screen.getByText("Name")).toBeInTheDocument();
  });

  it("should render description when provided", () => {
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ name: "John" }}
        renderers={renderers}
      />,
    );

    expect(screen.getByText("Enter your name")).toBeInTheDocument();
  });

  it("should handle data change", async () => {
    let changedData: unknown;
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ name: "" }}
        renderers={renderers}
        onChange={({ data }) => {
          changedData = data;
        }}
      />,
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Jane" } });

    await waitFor(() => {
      expect((changedData as { name: string }).name).toBe("Jane");
    });
  });

  it("should handle undefined data as empty string", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("");
  });

  it("should be enabled by default", () => {
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ name: "John" }}
        renderers={renderers}
      />,
    );

    const input = screen.getByRole("textbox");
    expect(input).not.toBeDisabled();
  });
});
