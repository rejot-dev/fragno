import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ControlElement, JsonSchema } from "@jsonforms/core";
import { NOT_APPLICABLE, RuleEffect } from "@jsonforms/core";
import { JsonForms } from "@jsonforms/react";
import { shadcnObjectControlTester, ShadcnObjectControlContext } from "./ShadcnObjectControl";
import { ShadcnTextControlContext, shadcnTextControlTester } from "./ShadcnTextControl";
import { ShadcnGroupLayoutContext, shadcnGroupLayoutTester } from "../layouts/ShadcnGroupLayout";
import {
  ShadcnVerticalLayoutContext,
  shadcnVerticalLayoutTester,
} from "../layouts/ShadcnVerticalLayout";
import { createTesterContext } from "../util/test-utils";

const schema: JsonSchema = {
  type: "object",
  properties: {
    foo: {
      type: "object",
      properties: {
        foo_1: { type: "string" },
      },
    },
    bar: {
      type: "object",
      properties: {
        bar_1: { type: "string" },
      },
    },
  },
};

const data = { foo: { foo_1: "foo value" }, bar: { bar_1: "bar value" } };

const uischemaRoot: ControlElement = {
  type: "Control",
  scope: "#",
};

const uischemaFoo: ControlElement = {
  type: "Control",
  scope: "#/properties/foo",
};

const renderers = [
  { tester: shadcnObjectControlTester, renderer: ShadcnObjectControlContext },
  { tester: shadcnTextControlTester, renderer: ShadcnTextControlContext },
  { tester: shadcnGroupLayoutTester, renderer: ShadcnGroupLayoutContext },
  { tester: shadcnVerticalLayoutTester, renderer: ShadcnVerticalLayoutContext },
];

describe("shadcnObjectControlTester", () => {
  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnObjectControlTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnObjectControlTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-Control type", () => {
    expect(shadcnObjectControlTester({ type: "Foo" }, schema, createTesterContext(schema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE for Control without scope", () => {
    expect(
      shadcnObjectControlTester({ type: "Control" }, schema, createTesterContext(schema)),
    ).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-object schema", () => {
    const stringSchema = {
      type: "object",
      properties: {
        foo: { type: "string" },
      },
    };
    expect(
      shadcnObjectControlTester(uischemaFoo, stringSchema, createTesterContext(stringSchema)),
    ).toBe(NOT_APPLICABLE);
  });

  it("should return rank 2 for object schema", () => {
    expect(shadcnObjectControlTester(uischemaFoo, schema, createTesterContext(schema))).toBe(2);
  });
});

describe("ShadcnObjectControl", () => {
  afterEach(() => cleanup());

  it("should render all nested object children", () => {
    render(<JsonForms schema={schema} uischema={uischemaRoot} data={data} renderers={renderers} />);

    const inputs = screen.getAllByRole("textbox");
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toHaveValue("foo value");
    expect(inputs[1]).toHaveValue("bar value");
  });

  it("should render only the targeted object property", () => {
    render(<JsonForms schema={schema} uischema={uischemaFoo} data={data} renderers={renderers} />);

    const inputs = screen.getAllByRole("textbox");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toHaveValue("foo value");
  });

  it("should render labels for nested properties", () => {
    render(<JsonForms schema={schema} uischema={uischemaFoo} data={data} renderers={renderers} />);

    expect(screen.getByText("Foo 1")).toBeInTheDocument();
  });

  it("should be enabled by default", () => {
    render(<JsonForms schema={schema} uischema={uischemaFoo} data={data} renderers={renderers} />);

    const input = screen.getByRole("textbox");
    expect(input).not.toBeDisabled();
  });

  it("should not render when visible is false", () => {
    // Use a rule to hide instead
    const schemaWithRule: JsonSchema = {
      ...schema,
    };

    const uischemaWithRule = {
      ...uischemaFoo,
      rule: {
        effect: RuleEffect.HIDE,
        condition: {
          scope: "#",
          schema: { type: "object" },
        },
      },
    };

    render(
      <JsonForms
        schema={schemaWithRule}
        uischema={uischemaWithRule}
        data={data}
        renderers={renderers}
      />,
    );

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("should render deeply nested objects", () => {
    const deepSchema: JsonSchema = {
      type: "object",
      properties: {
        level1: {
          type: "object",
          properties: {
            level2: {
              type: "object",
              properties: {
                value: { type: "string" },
              },
            },
          },
        },
      },
    };

    const deepData = { level1: { level2: { value: "deep value" } } };

    const deepUischema: ControlElement = {
      type: "Control",
      scope: "#",
    };

    render(
      <JsonForms
        schema={deepSchema}
        uischema={deepUischema}
        data={deepData}
        renderers={renderers}
      />,
    );

    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("deep value");
  });
});
