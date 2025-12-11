import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ControlElement, JsonSchema } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonForms } from "@jsonforms/react";
import { shadcnBooleanControlTester, ShadcnBooleanControlContext } from "./ShadcnBooleanControl";
import { createTesterContext } from "../util/test-utils";

const schema: JsonSchema = {
  type: "object",
  properties: {
    foo: {
      type: "boolean",
      title: "Test Label",
      description: "Test description",
    },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/foo",
};

const renderers = [{ tester: shadcnBooleanControlTester, renderer: ShadcnBooleanControlContext }];

describe("shadcnBooleanControlTester", () => {
  const control: ControlElement = {
    type: "Control",
    scope: "#/properties/foo",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnBooleanControlTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnBooleanControlTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnBooleanControlTester({ type: "Foo" }, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnBooleanControlTester({ type: "Control" }, undefined, undefined)).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE for non-boolean schema", () => {
    const rootSchema = { type: "object", properties: { foo: { type: "string" } } };
    expect(shadcnBooleanControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 2 for boolean schema", () => {
    const rootSchema = { type: "object", properties: { foo: { type: "boolean" } } };
    expect(shadcnBooleanControlTester(control, rootSchema, createTesterContext(rootSchema))).toBe(
      2,
    );
  });
});

describe("ShadcnBooleanControl", () => {
  afterEach(() => cleanup());

  it("should render checkbox with label", () => {
    render(
      <JsonForms schema={schema} uischema={uischema} data={{ foo: true }} renderers={renderers} />,
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toHaveAttribute("data-state", "checked");
    expect(screen.getByText("Test Label")).toBeInTheDocument();
  });

  it("should render checkbox unchecked when data is false", () => {
    render(
      <JsonForms schema={schema} uischema={uischema} data={{ foo: false }} renderers={renderers} />,
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toHaveAttribute("data-state", "unchecked");
  });

  it("should render description when provided", () => {
    render(
      <JsonForms schema={schema} uischema={uischema} data={{ foo: true }} renderers={renderers} />,
    );

    expect(screen.getByText("Test description")).toBeInTheDocument();
  });

  it("should handle data change when clicked", async () => {
    let changedData: unknown;
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ foo: true }}
        renderers={renderers}
        onChange={({ data }) => {
          changedData = data;
        }}
      />,
    );

    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect((changedData as { foo: boolean }).foo).toBe(false);
    });
  });

  it("should handle undefined data as unchecked", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toHaveAttribute("data-state", "unchecked");
  });

  it("should be enabled by default", () => {
    render(
      <JsonForms schema={schema} uischema={uischema} data={{ foo: true }} renderers={renderers} />,
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeDisabled();
  });
});
