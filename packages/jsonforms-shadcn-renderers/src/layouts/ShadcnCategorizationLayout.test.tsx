import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Categorization, JsonSchema } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonForms } from "@jsonforms/react";
import {
  shadcnCategorizationLayoutTester,
  ShadcnCategorizationLayoutContext,
} from "./ShadcnCategorizationLayout";
import { shadcnTextControlTester, ShadcnTextControlContext } from "../controls/ShadcnTextControl";
import { createTesterContext } from "../util/test-utils";

const schema: JsonSchema = {
  type: "object",
  properties: {
    firstName: {
      type: "string",
      title: "First Name",
    },
    lastName: {
      type: "string",
      title: "Last Name",
    },
    email: {
      type: "string",
      title: "Email",
    },
    phone: {
      type: "string",
      title: "Phone",
    },
  },
};

const uischema: Categorization = {
  type: "Categorization",
  label: "Test Form",
  elements: [
    {
      type: "Category",
      label: "Personal Info",
      elements: [
        { type: "Control", scope: "#/properties/firstName" },
        { type: "Control", scope: "#/properties/lastName" },
      ],
    },
    {
      type: "Category",
      label: "Contact Info",
      elements: [
        { type: "Control", scope: "#/properties/email" },
        { type: "Control", scope: "#/properties/phone" },
      ],
    },
  ],
};

const renderers = [
  { tester: shadcnCategorizationLayoutTester, renderer: ShadcnCategorizationLayoutContext },
  { tester: shadcnTextControlTester, renderer: ShadcnTextControlContext },
];

describe("shadcnCategorizationLayoutTester", () => {
  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnCategorizationLayoutTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnCategorizationLayoutTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-categorization type", () => {
    const uischema = { type: "VerticalLayout", elements: [] };
    expect(shadcnCategorizationLayoutTester(uischema, schema, createTesterContext(schema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE for categorization without categories", () => {
    const uischema: Categorization = {
      type: "Categorization",
      label: "Empty",
      elements: [],
    };
    expect(shadcnCategorizationLayoutTester(uischema, schema, createTesterContext(schema))).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return rank 1 for valid categorization with categories", () => {
    expect(shadcnCategorizationLayoutTester(uischema, schema, createTesterContext(schema))).toBe(1);
  });
});

describe("ShadcnCategorizationLayout", () => {
  afterEach(() => cleanup());

  it("should render first tab content by default", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    expect(screen.getByRole("tab", { name: "Personal Info" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Contact Info" })).toBeInTheDocument();
    expect(screen.getByText("First Name")).toBeInTheDocument();
    expect(screen.getByText("Last Name")).toBeInTheDocument();
  });

  it("should show first tab as selected by default", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const personalTab = screen.getByRole("tab", { name: "Personal Info" });
    const contactTab = screen.getByRole("tab", { name: "Contact Info" });
    expect(personalTab).toHaveAttribute("data-state", "active");
    expect(contactTab).toHaveAttribute("data-state", "inactive");
  });

  it("should render tabpanel with first category content", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const tabpanel = screen.getByRole("tabpanel");
    expect(tabpanel).toBeInTheDocument();
    expect(tabpanel).toHaveAttribute("data-state", "active");
  });
});
