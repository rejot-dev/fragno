// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from "vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { PreparedUploadedFileReference } from "@/fragno/prepared-upload";

import { BackofficeUiRenderer } from "../renderer";
import { parseBackofficeUiResult } from "../result";

const scope = { kind: "project" as const, orgId: "org-1", projectId: "project-1" };

const uploadUi = parseBackofficeUiResult({
  $ui: {
    version: 1,
    state: { response: { attachment: null } },
    spec: {
      root: "form",
      elements: {
        form: {
          type: "Stack",
          props: { gap: "md" },
          children: ["attachment", "submit"],
        },
        attachment: {
          type: "FileUpload",
          props: {
            label: "Supporting document",
            scope,
            value: { $bindState: "/response/attachment" },
            accept: [".pdf"],
            maxSizeBytes: 1_000,
            required: true,
          },
          children: [],
        },
        submit: {
          type: "WorkflowEventButton",
          props: {
            label: "Submit document",
            eventType: "document-submitted",
            payload: { $state: "/response" },
          },
          children: [],
        },
      },
    },
  },
});

if (uploadUi.kind !== "valid") {
  throw new Error("Expected FileUpload generated UI fixture to parse.");
}

afterEach(() => cleanup());

describe("FileUpload", () => {
  test("uploads a File and binds only the prepared reference into workflow state", async () => {
    const reference: PreparedUploadedFileReference = {
      kind: "prepared-upload",
      scope,
      uploadId: "upload-1",
      provider: "database",
      fileKey: "generated-ui/workflows/run/step/file.pdf",
      filename: "evidence.pdf",
      sizeBytes: 8,
      contentType: "application/pdf",
      expiresAt: "2027-01-01T00:00:00.000Z",
    };
    const uploadFile = vi.fn(async () => reference);
    const sendEvent = vi.fn(async () => undefined);

    render(
      <BackofficeUiRenderer
        ui={uploadUi.value.$ui}
        workflowInteractionHost={{
          canEditInput: () => true,
          canSendEvent: () => true,
          sendEvent,
          uploadFile,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit document" }));
    expect(sendEvent).not.toHaveBeenCalled();

    const file = new File(["evidence"], "evidence.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText(/Supporting document/), {
      target: { files: [file] },
    });

    await screen.findByText("8 B · Prepared");
    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ scope, file, bindingPath: "/response/attachment" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit document" }));
    await waitFor(() => {
      expect(sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "document-submitted",
          payload: { attachment: reference },
        }),
      );
    });
  });

  test("rejects disallowed files before invoking the upload host", async () => {
    const uploadFile = vi.fn();

    render(
      <BackofficeUiRenderer
        ui={uploadUi.value.$ui}
        workflowInteractionHost={{
          canEditInput: () => true,
          canSendEvent: () => true,
          sendEvent: async () => undefined,
          uploadFile,
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Supporting document/), {
      target: { files: [new File(["text"], "notes.txt", { type: "text/plain" })] },
    });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Choose one of these file types",
    );
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
