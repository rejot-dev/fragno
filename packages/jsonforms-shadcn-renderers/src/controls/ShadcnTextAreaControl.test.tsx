import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ControlElement, JsonSchema } from "@jsonforms/core";
import { NOT_APPLICABLE } from "@jsonforms/core";
import { JsonForms } from "@jsonforms/react";
import { shadcnTextAreaControlTester, ShadcnTextAreaControlContext } from "./ShadcnTextAreaControl";
import { createTesterContext } from "../util/test-utils";

const schema: JsonSchema = {
  type: "object",
  properties: {
    bio: {
      type: "string",
      title: "Biography",
      description: "Tell us about yourself",
    },
  },
};

const uischema: ControlElement = {
  type: "Control",
  scope: "#/properties/bio",
  options: {
    multi: true,
  },
};

const renderers = [{ tester: shadcnTextAreaControlTester, renderer: ShadcnTextAreaControlContext }];

describe("shadcnTextAreaControlTester", () => {
  const controlWithMulti: ControlElement = {
    type: "Control",
    scope: "#/properties/bio",
    options: { multi: true },
  };

  const controlWithoutMulti: ControlElement = {
    type: "Control",
    scope: "#/properties/bio",
  };

  it("should return NOT_APPLICABLE for invalid inputs", () => {
    // @ts-expect-error Testing invalid inputs
    expect(shadcnTextAreaControlTester(undefined, undefined, undefined)).toBe(NOT_APPLICABLE);
    // @ts-expect-error Testing invalid inputs
    expect(shadcnTextAreaControlTester(null, undefined, undefined)).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE when multi option is not set", () => {
    const rootSchema = { type: "object", properties: { bio: { type: "string" } } };
    expect(
      shadcnTextAreaControlTester(controlWithoutMulti, rootSchema, createTesterContext(rootSchema)),
    ).toBe(NOT_APPLICABLE);
  });

  it("should return NOT_APPLICABLE for non-string schema with multi", () => {
    const rootSchema = { type: "object", properties: { bio: { type: "number" } } };
    expect(
      shadcnTextAreaControlTester(controlWithMulti, rootSchema, createTesterContext(rootSchema)),
    ).toBe(NOT_APPLICABLE);
  });

  it("should return rank 2 for string schema with multi: true", () => {
    const rootSchema = { type: "object", properties: { bio: { type: "string" } } };
    expect(
      shadcnTextAreaControlTester(controlWithMulti, rootSchema, createTesterContext(rootSchema)),
    ).toBe(2);
  });
});

describe("ShadcnTextAreaControl", () => {
  afterEach(() => cleanup());

  it("should render textarea with label", () => {
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ bio: "Hello world" }}
        renderers={renderers}
      />,
    );

    const textarea = screen.getByRole("textbox");
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveValue("Hello world");
    expect(screen.getByText("Biography")).toBeInTheDocument();
  });

  it("should render description when provided", () => {
    render(
      <JsonForms schema={schema} uischema={uischema} data={{ bio: "" }} renderers={renderers} />,
    );

    expect(screen.getByText("Tell us about yourself")).toBeInTheDocument();
  });

  it("should handle data change", async () => {
    let changedData: unknown;
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ bio: "" }}
        renderers={renderers}
        onChange={({ data }) => {
          changedData = data;
        }}
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "New bio content" } });

    await waitFor(() => {
      expect((changedData as { bio: string }).bio).toBe("New bio content");
    });
  });

  it("should handle multiline content", async () => {
    let changedData: unknown;
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ bio: "" }}
        renderers={renderers}
        onChange={({ data }) => {
          changedData = data;
        }}
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Line 1\nLine 2\nLine 3" } });

    await waitFor(() => {
      expect((changedData as { bio: string }).bio).toBe("Line 1\nLine 2\nLine 3");
    });
  });

  it("should handle undefined data as empty string", () => {
    render(<JsonForms schema={schema} uischema={uischema} data={{}} renderers={renderers} />);

    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue("");
  });

  it("should be enabled by default", () => {
    render(
      <JsonForms
        schema={schema}
        uischema={uischema}
        data={{ bio: "Test" }}
        renderers={renderers}
      />,
    );

    const textarea = screen.getByRole("textbox");
    expect(textarea).not.toBeDisabled();
  });
});
