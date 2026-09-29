// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from "vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { BackofficeJsonForm } from "./backoffice-json-form";

afterEach(cleanup);

describe("BackofficeJsonForm", () => {
  test("renders generated text controls and submits valid data", async () => {
    const onSubmit = vi.fn();
    render(
      <BackofficeJsonForm
        schema={{
          type: "object",
          properties: {
            name: { type: "string", title: "Name", minLength: 1 },
            email: { type: "string", title: "Email", format: "email" },
          },
          required: ["name", "email"],
          additionalProperties: false,
        }}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText(/^Email/), {
      target: { value: "ada@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        name: "Ada Lovelace",
        email: "ada@example.com",
      });
    });
  });

  test("preserves valid empty strings in text and multiline controls", async () => {
    const onSubmit = vi.fn();
    render(
      <BackofficeJsonForm
        schema={{
          type: "object",
          properties: {
            summary: { type: "string", title: "Summary" },
            details: { type: "string", title: "Details" },
          },
          required: ["summary", "details"],
        }}
        uiSchema={{
          type: "VerticalLayout",
          elements: [
            { type: "Control", scope: "#/properties/summary" },
            { type: "Control", scope: "#/properties/details", options: { multi: true } },
          ],
        }}
        onSubmit={onSubmit}
      />,
    );

    for (const label of [/^Summary/, /^Details/]) {
      const input = screen.getByLabelText(label);
      fireEvent.change(input, { target: { value: "temporary" } });
      fireEvent.change(input, { target: { value: "" } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ summary: "", details: "" });
    });
  });

  test("shows human-facing validation guidance", async () => {
    render(
      <BackofficeJsonForm
        schema={{
          type: "object",
          properties: { email: { type: "string", title: "Email", format: "email" } },
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "not-an-email" } });

    expect(await screen.findByText("Enter a valid email address.")).not.toBeNull();
    expect(screen.queryByText(/does not match format/i)).toBeNull();
  });

  test("uses Base UI controls for enum and boolean fields", () => {
    render(
      <BackofficeJsonForm
        schema={{
          type: "object",
          properties: {
            plan: { type: "string", title: "Plan", enum: ["starter", "team"] },
            updates: { type: "boolean", title: "Product updates" },
          },
        }}
        uiSchema={{
          type: "VerticalLayout",
          elements: [
            { type: "Control", scope: "#/properties/plan" },
            { type: "Control", scope: "#/properties/updates" },
          ],
        }}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Plan" })).not.toBeNull();
    expect(screen.getByRole("checkbox", { name: "Product updates" })).not.toBeNull();
  });

  test("shows a submission summary when required data is missing", async () => {
    const onSubmit = vi.fn();
    render(
      <BackofficeJsonForm
        schema={{
          type: "object",
          properties: { name: { type: "string", title: "Name" } },
          required: ["name"],
        }}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));

    expect((await screen.findByRole("alert")).textContent).toContain("1 field needs attention");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
