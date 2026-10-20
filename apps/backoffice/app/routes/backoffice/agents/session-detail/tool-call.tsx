import { ActivityDisclosure } from "@fragno-private/design-system/activity-disclosure";
import { Button } from "@fragno-private/design-system/button";
import { ChatToolCallRow } from "@fragno-private/design-system/chat-message";
import { LabeledSection } from "@fragno-private/design-system/labeled-section";
import { ScrollablePre } from "@fragno-private/design-system/scrollable-pre";
import { SectionDisclosure } from "@fragno-private/design-system/section-disclosure";
import { useState } from "react";

import { useAuiState, type ToolCallMessagePartProps } from "@assistant-ui/react";

import { parseBackofficeUiResult, type BackofficeUiParseResult } from "@/backoffice-ui/result";

import { type PiDraftTool, type PiToolCallArtifact } from "./assistant-runtime";
import { getExecCodeModeResultDetails } from "./exec-code-mode";
import { formatJson, getLoadedSkillName, getReadPath } from "./tool-arguments";
import { ToolResultContent } from "./tool-result-content";
import { ToolArgumentsBlock } from "./tool-result-details";
import { ToolWorkspaceSelector, type ToolWorkspaceSelectorOption } from "./tool-workspace-selector";
import { useSessionWorkspaceNavigation } from "./workspace-context";
import { generatedUiWorkspaceId, workflowGraphWorkspaceId } from "./workspace-model";

const ordinaryResultPresentation: BackofficeUiParseResult = { kind: "ordinary" };

export function ToolCallBlock(props: ToolCallMessagePartProps) {
  const createdAt = useAuiState((state) => state.message.createdAt);
  const workspaceNavigation = useSessionWorkspaceNavigation();
  const artifact = (props.artifact ?? null) as PiToolCallArtifact | null;
  const draftTool = artifact?.draftTool ?? null;
  const completedToolResult = artifact?.completedToolResult ?? null;
  const loadedSkillName = getLoadedSkillName({
    argumentsValue: props.args,
    completedToolResult,
    name: props.toolName,
  });

  const readPath =
    props.toolName === "read"
      ? (getReadPath(props.args) ?? getReadPath(completedToolResult?.details))
      : null;
  const execCodeModeDetails =
    props.toolName === "execCodeMode"
      ? getExecCodeModeResultDetails(completedToolResult?.details)
      : null;
  const resultPresentation = execCodeModeDetails?.hasResult
    ? parseBackofficeUiResult(execCodeModeDetails.result)
    : ordinaryResultPresentation;
  const hasTaggedGeneratedUi = resultPresentation.kind !== "ordinary";
  const canExpandOrdinaryResult =
    (execCodeModeDetails?.hasResult ?? false) && resultPresentation.kind === "ordinary";
  const generatedUiItemId = generatedUiWorkspaceId(props.toolCallId);
  const workflowGraphItemId = workflowGraphWorkspaceId(props.toolCallId);
  const canShowGeneratedUi =
    resultPresentation.kind === "valid" && Boolean(workspaceNavigation?.hasItem(generatedUiItemId));
  const canShowWorkflowGraph = Boolean(workspaceNavigation?.hasItem(workflowGraphItemId));
  const workspaceOptions: ToolWorkspaceSelectorOption[] = [
    ...(canShowWorkflowGraph
      ? [{ id: workflowGraphItemId, kind: "workflow-graph" as const, label: "Workflow graph" }]
      : []),
    ...(canShowGeneratedUi
      ? [{ id: generatedUiItemId, kind: "generated-ui" as const, label: "Interface" }]
      : []),
  ];
  const [resultExpanded, setResultExpanded] = useState(false);
  const running =
    props.status.type === "running" || Boolean(draftTool && draftTool.status !== "done");
  const status = running
    ? toolStatusLabel(draftTool)
    : completedToolResult?.isError
      ? "Failed"
      : "Done";

  const displayLabel = loadedSkillName ? "Skill loaded" : props.toolName;
  const displayDetail = loadedSkillName ?? readPath ?? status;

  const completedResultSection = completedToolResult ? (
    <LabeledSection
      label={completedToolResult.isError ? "Error" : "Result"}
      action={
        canExpandOrdinaryResult ? (
          <Button
            variant="ghost"
            onClick={() => {
              setResultExpanded((current) => !current);
            }}
          >
            {resultExpanded ? "Hide raw" : "Show raw"}
          </Button>
        ) : null
      }
    >
      <ToolResultContent
        expanded={canExpandOrdinaryResult && resultExpanded}
        hasRawResult={execCodeModeDetails?.hasResult ?? false}
        parsedResult={resultPresentation}
        rawResult={execCodeModeDetails?.result}
        result={completedToolResult}
        useExecCodeModeFormatting={execCodeModeDetails !== null}
      />
    </LabeledSection>
  ) : null;

  const partialResult =
    draftTool?.partialResult !== undefined ? (
      <ScrollablePre>{formatJson(draftTool.partialResult)}</ScrollablePre>
    ) : null;
  const logs =
    execCodeModeDetails && execCodeModeDetails.logs.length > 0 ? (
      <ScrollablePre>{execCodeModeDetails.logs.join("\n")}</ScrollablePre>
    ) : null;

  return (
    <ChatToolCallRow
      actions={<ToolWorkspaceSelector options={workspaceOptions} toolLabel={displayLabel} />}
    >
      <ActivityDisclosure
        key={props.toolCallId}
        marker={running ? "progress" : completedToolResult?.isError ? "failed" : "live"}
        outline={loadedSkillName ? "live" : completedToolResult?.isError ? "failed" : "default"}
        title={displayLabel}
        detail={displayDetail}
        time={createdAt ?? null}
        autoOpen={hasTaggedGeneratedUi}
      >
        {hasTaggedGeneratedUi && completedToolResult ? (
          <>
            {completedResultSection}
            <SectionDisclosure label="Code">
              <ToolArgumentsBlock rawText={props.argsText} value={props.args} />
            </SectionDisclosure>
            {partialResult ? (
              <SectionDisclosure label="Live result">{partialResult}</SectionDisclosure>
            ) : null}
            {logs ? <SectionDisclosure label="Logs">{logs}</SectionDisclosure> : null}
          </>
        ) : (
          <>
            <ToolArgumentsBlock rawText={props.argsText} value={props.args} />
            {partialResult ? (
              <LabeledSection label="Live result">{partialResult}</LabeledSection>
            ) : null}
            {logs ? <LabeledSection label="Logs">{logs}</LabeledSection> : null}
            {completedResultSection}
          </>
        )}
      </ActivityDisclosure>
    </ChatToolCallRow>
  );
}

function toolStatusLabel(draftTool: PiDraftTool | null) {
  if (!draftTool || draftTool.status === "running") {
    return "Running";
  }
  if (draftTool.status === "done") {
    return "Done";
  }
  return "Preparing";
}
