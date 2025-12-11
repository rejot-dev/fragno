import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ControlElement, JsonSchema } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonFormsStateProvider } from "@jsonforms/react";
import { shadcnSliderCellTester, ShadcnSliderCellContext } from "./ShadcnSliderCell";
import { initCore, createTesterContext } from "../util/test-utils";

const schema: JsonSchema = {
  type: "object",
  properties: {
    rating: {
      type: "number",
      minimum: 0,
      maximum: 10,
      default: 5,
    },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/rating",
  options: { slider: true },
};

describe("shadcnSliderCellTester", () => {
  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnSliderCellTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnSliderCellTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-range control", () => {
    const uischema = { type: "Control", scope: "#/properties/rating" };
    expect(shadcnSliderCellTester(uischema, schema, createTesterContext(schema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 2 for valid range control with slider option", () => {
    expect(shadcnSliderCellTester(uischema, schema, createTesterContext(schema))).toBe(2);
  });
});

describe("ShadcnSliderCell", () => {
  afterEach(() => cleanup());

  it("should render slider with value", () => {
    const core = initCore(schema, uischema, { rating: 7 });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnSliderCellContext
          schema={{ type: "number", minimum: 0, maximum: 10, default: 5 }}
          uischema={uischema}
          path="rating"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    expect(screen.getByRole("slider")).toBeInTheDocument();
  });

  it("should use default value when data is undefined", () => {
    const core = initCore(schema, uischema, {});
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnSliderCellContext
          schema={{ type: "number", minimum: 0, maximum: 10, default: 5 }}
          uischema={uischema}
          path="rating"
          enabled={true}
        />
      </JsonFormsStateProvider>,
    );

    expect(screen.getByRole("slider")).toBeInTheDocument();
  });

  it("should be disabled when enabled=false", () => {
    const core = initCore(schema, uischema, { rating: 5 });
    render(
      <JsonFormsStateProvider initState={{ renderers: [], cells: [], core }}>
        <ShadcnSliderCellContext
          schema={{ type: "number", minimum: 0, maximum: 10, default: 5 }}
          uischema={uischema}
          path="rating"
          enabled={false}
        />
      </JsonFormsStateProvider>,
    );

    expect(screen.getByRole("slider")).toHaveAttribute("data-disabled");
  });
});
