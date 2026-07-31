import { describe, expect, test } from "vitest";

import {
  autoOpenNewWorkflowWorkspaceItem,
  createSessionWorkspaceState,
  generatedUiWorkspaceId,
  toggleSessionWorkspaceItem,
  updateSessionWorkspaceStateBySession,
  workflowGraphWorkspaceId,
  type SessionWorkspaceItem,
} from "./workspace-model";

const workspaceItem = (
  id: string,
  type: SessionWorkspaceItem["view"]["type"],
): SessionWorkspaceItem => ({ id, view: { type } }) as SessionWorkspaceItem;

describe("session workspace selection", () => {
  test("starts closed before workspace information is observed", () => {
    expect(createSessionWorkspaceState()).toEqual({
      open: false,
      selectedItemId: null,
    });
  });

  test("automatically opens a newly produced workflow", () => {
    const interfaceItem = workspaceItem(generatedUiWorkspaceId("tool-call"), "generated-ui");
    const workflowItem = workspaceItem(workflowGraphWorkspaceId("tool-call"), "workflow-graph");

    expect(
      autoOpenNewWorkflowWorkspaceItem(createSessionWorkspaceState(), [
        workflowItem,
        interfaceItem,
      ]),
    ).toEqual({
      open: true,
      selectedItemId: workflowItem.id,
      observedItemIds: [workflowItem.id, interfaceItem.id],
    });
  });

  test("does not reopen a workflow after the user closes it", () => {
    const workflowItem = workspaceItem(workflowGraphWorkspaceId("first"), "workflow-graph");
    const opened = autoOpenNewWorkflowWorkspaceItem(createSessionWorkspaceState(), [workflowItem]);
    const closed = { ...opened, open: false };

    expect(autoOpenNewWorkflowWorkspaceItem(closed, [workflowItem])).toBe(closed);
  });

  test("opens the latest workflow when another codemode workflow is produced", () => {
    const firstWorkflow = workspaceItem(workflowGraphWorkspaceId("first"), "workflow-graph");
    const secondWorkflow = workspaceItem(workflowGraphWorkspaceId("second"), "workflow-graph");
    const firstOpened = autoOpenNewWorkflowWorkspaceItem(createSessionWorkspaceState(), [
      firstWorkflow,
    ]);
    const firstClosed = { ...firstOpened, open: false };

    expect(autoOpenNewWorkflowWorkspaceItem(firstClosed, [firstWorkflow, secondWorkflow])).toEqual({
      open: true,
      selectedItemId: secondWorkflow.id,
      observedItemIds: [firstWorkflow.id, secondWorkflow.id],
    });
  });

  test("keeps independent workspace state for each session in memory", () => {
    const firstSessionId = "session-a";
    const secondSessionId = "session-b";
    const itemId = generatedUiWorkspaceId("interface");
    const states = updateSessionWorkspaceStateBySession({}, firstSessionId, (current) =>
      toggleSessionWorkspaceItem(current, itemId),
    );

    expect(states[firstSessionId]).toEqual({ open: true, selectedItemId: itemId });
    expect(states[secondSessionId] ?? createSessionWorkspaceState()).toEqual({
      open: false,
      selectedItemId: null,
    });
  });

  test("opens the panel for the selected tool information", () => {
    const itemId = workflowGraphWorkspaceId("workflow");

    expect(toggleSessionWorkspaceItem(createSessionWorkspaceState(), itemId)).toEqual({
      open: true,
      selectedItemId: itemId,
    });
  });

  test("switches the open panel when different information is selected", () => {
    const workflowId = workflowGraphWorkspaceId("workflow");
    const interfaceId = generatedUiWorkspaceId("interface");
    const workflowSelected = toggleSessionWorkspaceItem(createSessionWorkspaceState(), workflowId);

    expect(toggleSessionWorkspaceItem(workflowSelected, interfaceId)).toEqual({
      open: true,
      selectedItemId: interfaceId,
    });
  });

  test("closes the panel when its current selector is pressed again", () => {
    const itemId = generatedUiWorkspaceId("interface");
    const selected = toggleSessionWorkspaceItem(createSessionWorkspaceState(), itemId);

    expect(toggleSessionWorkspaceItem(selected, itemId)).toEqual({
      open: false,
      selectedItemId: itemId,
    });
  });

  test("reopens the previously selected information", () => {
    const itemId = generatedUiWorkspaceId("interface");
    const selected = toggleSessionWorkspaceItem(createSessionWorkspaceState(), itemId);
    const closed = toggleSessionWorkspaceItem(selected, itemId);

    expect(toggleSessionWorkspaceItem(closed, itemId)).toEqual(selected);
  });
});
