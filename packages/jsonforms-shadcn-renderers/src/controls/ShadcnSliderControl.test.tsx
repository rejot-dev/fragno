import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { JsonSchema } from "@jsonforms/core";
import { NOT_APPLICABLE, RuleEffect } from "@jsonforms/core";
import { JsonForms } from "@jsonforms/react";
import { shadcnSliderControlTester, ShadcnSliderControlContext } from "./ShadcnSliderControl";
import { createTesterContext } from "../util/test-utils";

const schema: JsonSchema = {
  type: "object",
  properties: {
    rating: {
      type: "number",
      minimum: 0,
      maximum: 10,
      default: 5,
      title: "Rating",
      description: "Rate from 0 to 10",
    },
  },
};

const uischema = {
  type: "Control",
  scope: "#/properties/rating",
  options: { slider: true },
};

const renderers = [{ tester: shadcnSliderControlTester, renderer: ShadcnSliderControlContext }];

describe("shadcnSliderControlTester", () => {
  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnSliderControlTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnSliderControlTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-range control", () => {
    const uischema = { type: "Control", scope: "#/properties/rating" };
    expect(shadcnSliderControlTester(uischema, schema, createTesterContext(schema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE for string type", () => {
    const stringSchema: JsonSchema = {
      type: "object",
      properties: {
        rating: { type: "string" },
      },
    };
    expect(
      shadcnSliderControlTester(uischema, stringSchema, createTesterContext(stringSchema)),
    ).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE when missing minimum", () => {
    const schemaNoMin: JsonSchema = {
      type: "object",
      properties: {
        rating: { type: "number", maximum: 10, default: 5 },
      },
    };
    expect(shadcnSliderControlTester(uischema, schemaNoMin, createTesterContext(schemaNoMin))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE when missing maximum", () => {
    const schemaNoMax: JsonSchema = {
      type: "object",
      properties: {
        rating: { type: "number", minimum: 0, default: 5 },
      },
    };
    expect(shadcnSliderControlTester(uischema, schemaNoMax, createTesterContext(schemaNoMax))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE when missing default", () => {
    const schemaNoDefault: JsonSchema = {
      type: "object",
      properties: {
        rating: { type: "number", minimum: 0, maximum: 10 },
      },
    };
    expect(
      shadcnSliderControlTester(uischema, schemaNoDefault, createTesterContext(schemaNoDefault)),
    ).toBe(NOT_APPLICABLE);
  });

  it("should return rank 5 for valid range control with slider option", () => {
    expect(shadcnSliderControlTester(uischema, schema, createTesterContext(schema))).toBe(5);
  });

  it("should return rank 5 for integer type", () => {
    const integerSchema: JsonSchema = {
      type: "object",
      properties: {
        rating: { type: "integer", minimum: 0, maximum: 10, default: 5 },
      },
    };
    expect(
      shadcnSliderControlTester(uischema, integerSchema, createTesterContext(integerSchema)),
    ).toBe(5);
  });
});

describe("ShadcnSliderControl", () => {
  afterEach(() => cleanup());

  it("should render slider with label", () => {
    render(
      <JsonForms schema={schema} uischema={uischema} data={{ rating: 7 }} renderers={renderers} />,
    );

    expect(screen.getByText("Rating")).toBeInTheDocument();
    expect(screen.getByRole("slider")).toBeInTheDocument();
  });

  it("should display current value", () => {
    render(
      <JsonForms schema={schema} uischema={uischema} data={{ rating: 7 }} renderers={renderers} />,
    );

    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("should display min and max labels", () => {
    render(
      <JsonForms schema={schema} uischema={uischema} data={{ rating: 5 }} renderers={renderers} />,
    );

    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
  });

  it("should display description", () => {
    render(
      <JsonForms schema={schema} uischema={uischema} data={{ rating: 5 }} renderers={renderers} />,
    );

    expect(screen.getByText("Rate from 0 to 10")).toBeInTheDocument();
  });

  it("should use default value when data is undefined", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("should be disabled when enabled is false", () => {
    render(
      <JsonForms
        schema={schema}
        uischema={{ ...uischema, options: { slider: true, readonly: true } }}
        data={{ rating: 5 }}
        renderers={renderers}
        readonly
      />,
    );

    expect(screen.getByRole("slider")).toHaveAttribute("data-disabled");
  });

  it("should not render when visible is false", () => {
    const uischemaHidden = {
      ...uischema,
      rule: {
        effect: RuleEffect.HIDE,
        condition: { scope: "#", schema: {} },
      },
    };
    render(
      <JsonForms
        schema={schema}
        uischema={uischemaHidden}
        data={{ rating: 5 }}
        renderers={renderers}
      />,
    );

    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });
});
