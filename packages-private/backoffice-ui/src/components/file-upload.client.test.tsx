// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from "vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { GeneratedUiUploadedFile } from "../generated-ui-upload";
import { BackofficeUiRenderer } from "../renderer";
import { parseBackofficeUiResult } from "../result";
import type { WorkflowUiInteractionHost } from "../workflow-interaction";

const scope = {
  kind: "project" as const,
  owner: { kind: "org" as const, orgId: "org-1", jurisdiction: null },
  projectId: "project-1",
};

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
  test("uploads a File and binds only the uploaded workspace file into workflow state", async () => {
    const reference: GeneratedUiUploadedFile = {
      scope,
      path: "/workspace/uploads/run/2f0c6f1e-4d0b-4b8f-9c1a-6b8e1f2d3c4a/file.pdf",
      filename: "evidence.pdf",
      sizeBytes: 8,
      contentType: "application/pdf",
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

    await screen.findByText("8 B · Uploaded");
    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        scope,
        file,
        replaces: null,
        bindingPath: "/response/attachment",
      }),
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

  test("replacing an uploaded file hands the file it replaces to the host", async () => {
    const first: GeneratedUiUploadedFile = {
      scope,
      path: "/workspace/uploads/run/9a1d6f0e-1c2b-4d3e-8f4a-5b6c7d8e9f01/draft.pdf",
      filename: "draft.pdf",
      sizeBytes: 5,
      contentType: "application/pdf",
    };
    const second: GeneratedUiUploadedFile = {
      ...first,
      path: "/workspace/uploads/run/0b2e7a1f-2d3c-4e4f-9a5b-6c7d8e9f0a12/final.pdf",
      filename: "final.pdf",
    };
    const uploadFile = vi.fn<WorkflowUiInteractionHost["uploadFile"]>();
    uploadFile.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    render(
      <BackofficeUiRenderer
        ui={uploadUi.value.$ui}
        workflowInteractionHost={{
          canEditInput: () => true,
          canSendEvent: () => true,
          sendEvent: vi.fn(async () => undefined),
          uploadFile,
        }}
      />,
    );

    const input = screen.getByLabelText(/Supporting document/);
    fireEvent.change(input, {
      target: { files: [new File(["draft"], "draft.pdf", { type: "application/pdf" })] },
    });
    await screen.findByText("draft.pdf");
    const replacement = new File(["final"], "final.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [replacement] } });
    await screen.findByText("final.pdf");

    expect(uploadFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ file: replacement, replaces: first }),
    );
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
