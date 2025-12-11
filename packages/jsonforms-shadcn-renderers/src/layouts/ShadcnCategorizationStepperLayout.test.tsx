import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { Categorization, JsonSchema } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonForms } from "@jsonforms/react";
import {
  shadcnCategorizationStepperLayoutTester,
  ShadcnCategorizationStepperLayoutContext,
} from "./ShadcnCategorizationStepperLayout";
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
  options: { variant: "stepper" },
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
  {
    tester: shadcnCategorizationStepperLayoutTester,
    renderer: ShadcnCategorizationStepperLayoutContext,
  },
  { tester: shadcnTextControlTester, renderer: ShadcnTextControlContext },
];

describe("shadcnCategorizationStepperLayoutTester", () => {
  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnCategorizationStepperLayoutTester(undefined, undefined, undefined)).toBe(
      NOT_APPLICABLE,
    );
    // @ts-expect-error Testing invalid inputs
    expect(shadcnCategorizationStepperLayoutTester(null, undefined, undefined)).toBe(
      NOT_APPLICABLE,
    );
  });

  it("should return NOT_APPLICABLE for non-categorization type", () => {
    const uischema = { type: "VerticalLayout", elements: [] };
    expect(
      shadcnCategorizationStepperLayoutTester(uischema, schema, createTesterContext(schema)),
    ).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for categorization without stepper variant", () => {
    const uischema: Categorization = {
      type: "Categorization",
      label: "No Stepper",
      elements: [{ type: "Category", label: "A", elements: [] }],
    };
    expect(
      shadcnCategorizationStepperLayoutTester(uischema, schema, createTesterContext(schema)),
    ).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for categorization without categories", () => {
    const uischema: Categorization = {
      type: "Categorization",
      label: "Empty",
      options: { variant: "stepper" },
      elements: [],
    };
    expect(
      shadcnCategorizationStepperLayoutTester(uischema, schema, createTesterContext(schema)),
    ).toBe(NOT_APPLICABLE);
  });

  it("should return rank 2 for valid categorization with stepper variant", () => {
    expect(
      shadcnCategorizationStepperLayoutTester(uischema, schema, createTesterContext(schema)),
    ).toBe(2);
  });
});

describe("ShadcnCategorizationStepperLayout", () => {
  afterEach(() => cleanup());

  it("should render first step by default", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    expect(screen.getByText("Personal Info")).toBeInTheDocument();
    expect(screen.getByText("First Name")).toBeInTheDocument();
    expect(screen.getByText("Last Name")).toBeInTheDocument();
  });

  it("should render step indicators", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    expect(screen.getByRole("button", { name: "1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2" })).toBeInTheDocument();
  });

  it("should navigate to next step when clicking Next", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const nextButton = screen.getByRole("button", { name: "Next" });
    fireEvent.click(nextButton);

    expect(screen.getByText("Contact Info")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByText("Phone")).toBeInTheDocument();
  });

  it("should navigate to previous step when clicking Previous", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    // Go to step 2
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Contact Info")).toBeInTheDocument();

    // Go back to step 1
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByText("Personal Info")).toBeInTheDocument();
  });

  it("should navigate to step when clicking step indicator", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    // Click on step 2 indicator
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(screen.getByText("Contact Info")).toBeInTheDocument();

    // Click on step 1 indicator
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    expect(screen.getByText("Personal Info")).toBeInTheDocument();
  });

  it("should disable Previous button on first step", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const previousButton = screen.getByRole("button", { name: "Previous" });
    expect(previousButton).toBeDisabled();
  });

  it("should hide Next button on last step", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    // Go to last step
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });
});
