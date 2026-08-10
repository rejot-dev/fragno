// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi, assert } from "vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { BackofficeUiRenderer } from "./renderer";
import { parseBackofficeUiResult } from "./result";
import type { WorkflowUiEventInput, WorkflowUiInteractionHost } from "./workflow-interaction";

const interactiveResult = parseBackofficeUiResult({
  $ui: {
    version: 1,
    state: { response: { decision: "approve", reason: "" } },
    spec: {
      root: "form",
      elements: {
        form: {
          type: "Stack",
          props: { gap: "md" },
          children: ["decision", "reason", "submit"],
        },
        decision: {
          type: "Select",
          props: {
            label: "Decision",
            value: { $bindState: "/response/decision" },
            options: [
              { label: "Approve", value: "approve" },
              { label: "Reject", value: "reject" },
            ],
          },
          children: [],
        },
        reason: {
          type: "TextArea",
          props: { label: "Reason", value: { $bindState: "/response/reason" } },
          children: [],
        },
        submit: {
          type: "WorkflowEventButton",
          props: {
            label: "Submit decision",
            eventType: "approval",
            payload: { $state: "/response" },
          },
          children: [],
        },
      },
    },
  },
});

if (interactiveResult.kind !== "valid") {
  throw new Error("Expected interactive generated UI fixture to parse.");
}

afterEach(() => cleanup());

const unexpectedUpload: WorkflowUiInteractionHost["uploadFile"] = async () => {
  throw new Error("This test does not render a file upload.");
};

describe("Backoffice generated UI workflow input", () => {
  test("binds form state and sends the resolved payload", async () => {
    const sendEvent = vi.fn(async () => undefined);

    render(
      <BackofficeUiRenderer
        ui={interactiveResult.value.$ui}
        workflowInteractionHost={{
          canEditInput: () => true,
          canSendEvent: (eventType) => eventType === "approval",
          sendEvent,
          uploadFile: unexpectedUpload,
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("Decision"), { target: { value: "reject" } });
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Missing supporting evidence" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit decision" }));

    await waitFor(() => {
      expect(sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: expect.any(String),
          eventType: "approval",
          payload: { decision: "reject", reason: "Missing supporting evidence" },
        }),
      );
    });
    assert((screen.getByRole("button", { name: "Sent" }) as HTMLButtonElement).disabled);
  });

  test("blocks workflow submission until required controls are valid", async () => {
    const requiredInputResult = parseBackofficeUiResult({
      $ui: {
        version: 1,
        state: { response: { name: "", confirmed: false } },
        spec: {
          root: "form",
          elements: {
            form: {
              type: "Stack",
              props: { gap: "md" },
              children: ["name", "confirmed", "submit"],
            },
            name: {
              type: "TextInput",
              props: {
                label: "Name",
                value: { $bindState: "/response/name" },
                required: true,
              },
              children: [],
            },
            confirmed: {
              type: "Checkbox",
              props: {
                label: "I confirm",
                checked: { $bindState: "/response/confirmed" },
                required: true,
              },
              children: [],
            },
            submit: {
              type: "WorkflowEventButton",
              props: {
                label: "Continue",
                eventType: "confirmed",
                payload: { $state: "/response" },
              },
              children: [],
            },
          },
        },
      },
    });
    assert(requiredInputResult.kind === "valid");
    const sendEvent = vi.fn(async () => undefined);

    render(
      <BackofficeUiRenderer
        ui={requiredInputResult.value.$ui}
        workflowInteractionHost={{
          canEditInput: () => true,
          canSendEvent: () => true,
          sendEvent,
          uploadFile: unexpectedUpload,
        }}
      />,
    );

    const submit = screen.getByRole("button", { name: "Continue" });
    fireEvent.click(submit);
    expect(sendEvent).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox", { name: /Name/ }), {
      target: { value: "Ada" },
    });
    fireEvent.click(submit);
    expect(sendEvent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /I confirm/ }));
    fireEvent.click(submit);
    await waitFor(() => {
      expect(sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "confirmed",
          payload: { name: "Ada", confirmed: true },
        }),
      );
    });
  });

  test("reuses the event id when a failed submission is retried", async () => {
    const sendEvent = vi
      .fn<(input: WorkflowUiEventInput) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValue(undefined);

    render(
      <BackofficeUiRenderer
        ui={interactiveResult.value.$ui}
        workflowInteractionHost={{
          canEditInput: () => true,
          canSendEvent: (eventType) => eventType === "approval",
          sendEvent,
          uploadFile: unexpectedUpload,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit decision" }));
    await screen.findByRole("button", { name: "Try again" });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: "Sent" });

    const firstEventId = sendEvent.mock.calls[0]?.[0].eventId;
    expect(firstEventId).toEqual(expect.any(String));
    expect(sendEvent.mock.calls[1]?.[0].eventId).toBe(firstEventId);
  });

  test("renders secret text input values as passwords", () => {
    const secretInputResult = parseBackofficeUiResult({
      $ui: {
        version: 1,
        state: { apiKey: "sk-secret" },
        spec: {
          root: "api-key",
          elements: {
            "api-key": {
              type: "TextInput",
              props: {
                label: "API key",
                value: { $bindState: "/apiKey" },
                secret: true,
              },
              children: [],
            },
          },
        },
      },
    });
    assert(secretInputResult.kind === "valid");

    render(<BackofficeUiRenderer ui={secretInputResult.value.$ui} />);

    const input = screen.getByLabelText("API key");
    assert(input instanceof HTMLInputElement);
    assert.equal(input.type, "password");
    assert.equal(input.value, "sk-secret");
  });

  test("renders hostless workflow input as read-only without describing it as stale", () => {
    render(<BackofficeUiRenderer ui={interactiveResult.value.$ui} />);

    assert((screen.getByRole("button", { name: "Submit decision" }) as HTMLButtonElement).disabled);
    assert((screen.getByLabelText("Reason") as HTMLTextAreaElement).disabled);
    expect(screen.queryByText("This workflow is no longer waiting for approval.")).toBeNull();
  });

  test("disables stale workflow input", () => {
    render(
      <BackofficeUiRenderer
        ui={interactiveResult.value.$ui}
        workflowInteractionHost={{
          canEditInput: () => false,
          canSendEvent: () => false,
          sendEvent: async () => undefined,
          uploadFile: unexpectedUpload,
        }}
      />,
    );

    assert((screen.getByRole("button", { name: "Submit decision" }) as HTMLButtonElement).disabled);
    const reason = screen.getByLabelText("Reason");
    assert(reason instanceof HTMLTextAreaElement);
    assert(reason.disabled);
    expect(screen.getByText("This workflow is no longer waiting for approval.")).toBeDefined();
  });
});
