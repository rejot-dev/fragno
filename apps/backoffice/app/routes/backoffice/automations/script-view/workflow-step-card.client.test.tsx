// @vitest-environment happy-dom

import { afterEach, assert, describe, expect, test, vi } from "vitest";

import type { StepNode } from "@fragno-dev/workflow-visualizer-tokens";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { WorkflowEventSender } from "./workflow-generated-ui";
import type { WorkflowRunEvent, WorkflowStepRunState } from "./workflow-run-presentation";
import { WorkflowStepCard } from "./workflow-step-card";
import { workflowUiDraftId, workflowUiDrafts } from "./workflow-ui-drafts.client";

const step: StepNode = {
  id: "step:request-approval",
  kind: "step",
  label: "request approval",
  stepType: "do",
  workflowName: "approval-workflow",
  order: 1,
  sourceOrder: 1,
  parentId: "workflow:approval-workflow",
  source: {
    path: "automations/approval.workflow.js",
    start: { offset: 0, line: 1, column: 0 },
    end: { offset: 20, line: 1, column: 20 },
  },
  meta: {},
  analysis: { status: "complete", invocations: [], returns: [] },
  construction: { status: "complete", phase: "complete" },
};

function workflowInputResult(payload: unknown) {
  return {
    $ui: {
      version: 1,
      state: { response: { decision: "approve", reason: "" } },
      spec: {
        root: "form",
        elements: {
          form: {
            type: "Stack",
            props: { gap: "md" },
            children: ["reason", "submit"],
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
              payload,
            },
            children: [],
          },
        },
      },
    },
  };
}

const runState: WorkflowStepRunState = {
  stepRecordId: "workflow-step-record-1",
  status: "completed",
  attempts: 1,
  completedAt: "2026-08-03T09:00:00.000Z",
  emissionCount: 0,
  current: false,
  result: workflowInputResult({
    decision: { $state: "/response/decision" },
    reason: { $state: "/response/reason" },
  }),
};

afterEach(() => cleanup());

describe("WorkflowStepCard generated UI state", () => {
  test("enables workflow event buttons with literal payloads", async () => {
    const workflowEventSender = vi.fn(async () => undefined);
    const literalPayloadState: WorkflowStepRunState = {
      ...runState,
      result: workflowInputResult({ approved: true }),
    };

    render(
      <WorkflowStepCard
        step={step}
        runState={literalPayloadState}
        workflowEventSender={workflowEventSender}
        workflowEventWorkflowName="codemode-script"
        workflowInstanceId="instance-1"
        waitingEventTypes={["approval"]}
      />,
    );

    const submit = await screen.findByRole("button", { name: "Submit decision" });
    assert(submit instanceof HTMLButtonElement);
    assert(!submit.disabled);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(workflowEventSender).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: expect.any(String),
          workflowName: "codemode-script",
          instanceId: "instance-1",
          eventType: "approval",
          payload: { approved: true },
        }),
      );
    });
  });

  test("persists the event id before sending and reuses it after remounting", async () => {
    const runRecordId = `workflow-run:${crypto.randomUUID()}`;
    const draftId = workflowUiDraftId({
      runRecordId,
      stepRecordId: "workflow-step-record-1",
    });
    const workflowEventSender = vi
      .fn<WorkflowEventSender>()
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValue(undefined);
    const renderCard = () =>
      render(
        <WorkflowStepCard
          step={step}
          runState={runState}
          workflowEvents={[]}
          workflowRunRecordId={runRecordId}
          workflowEventSender={workflowEventSender}
          workflowEventWorkflowName="codemode-script"
          workflowInstanceId="instance-1"
          waitingEventTypes={["approval"]}
        />,
      );

    const firstRender = renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Submit decision" }));
    await screen.findByRole("button", { name: "Try again" });
    const persistedEventId = workflowUiDrafts.get(draftId)?.eventIds?.approval;
    expect(persistedEventId).toEqual(expect.any(String));
    expect(workflowEventSender.mock.calls[0]?.[0].eventId).toBe(persistedEventId);
    firstRender.unmount();

    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Submit decision" }));
    await screen.findByRole("button", { name: "Sent" });

    expect(workflowEventSender.mock.calls[1]?.[0].eventId).toBe(persistedEventId);
  });

  test("uses browser drafts only while waiting, then uses the synced workflow event", async () => {
    const runRecordId = `workflow-run:${crypto.randomUUID()}`;
    const draftId = workflowUiDraftId({
      runRecordId,
      stepRecordId: "workflow-step-record-1",
    });
    const workflowEventSender = vi.fn(async () => undefined);
    const renderCard = (workflowEvents: readonly WorkflowRunEvent[], waitingEventTypes: string[]) =>
      render(
        <WorkflowStepCard
          step={step}
          runState={runState}
          workflowEvents={workflowEvents}
          workflowRunRecordId={runRecordId}
          workflowEventSender={workflowEventSender}
          workflowEventWorkflowName="codemode-script"
          workflowInstanceId="instance-1"
          waitingEventTypes={waitingEventTypes}
        />,
      );
    const firstRender = renderCard([], ["approval"]);

    fireEvent.change(await screen.findByLabelText("Reason"), {
      target: { value: "Missing evidence" },
    });
    await expect
      .poll(() => workflowUiDrafts.get(draftId)?.state)
      .toMatchObject({
        response: { reason: "Missing evidence" },
      });
    firstRender.unmount();
    const restoredRender = renderCard([], ["approval"]);
    const restoredReason = await screen.findByLabelText("Reason");
    assert(restoredReason instanceof HTMLTextAreaElement);
    assert(restoredReason.value === "Missing evidence");

    fireEvent.click(screen.getByRole("button", { name: "Submit decision" }));
    await waitFor(() => {
      expect(workflowEventSender).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: expect.any(String),
          eventType: "approval",
          payload: { decision: "approve", reason: "Missing evidence" },
        }),
      );
    });
    await expect.poll(() => workflowUiDrafts.get(draftId)?.submittedEventType).toBe("approval");
    restoredRender.unmount();

    renderCard(
      [
        {
          id: "workflow-event-1",
          actor: "user",
          type: "approval",
          payload: { decision: "reject", reason: "Submitted reason" },
          createdAt: "2026-08-03T09:05:00.000Z",
          deliveredAt: "2026-08-03T09:05:01.000Z",
          consumedByStepKey: "waitForEvent:approval",
        },
      ],
      [],
    );

    const submittedReason = screen.getByLabelText("Reason");
    assert(submittedReason instanceof HTMLTextAreaElement);
    assert(submittedReason.value === "Submitted reason");
    assert(submittedReason.disabled);
    await expect.poll(() => workflowUiDrafts.has(draftId)).toBe(false);
  });
});
