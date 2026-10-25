import {
  parseBackofficeUiResult,
  type BackofficeUiParseResult,
} from "@fragno-private/backoffice-ui/result";
import { Button } from "@fragno-private/design-system/button";
import { ChatActivityStep } from "@fragno-private/design-system/chat-activity";
import {
  ChatCodemodeStep,
  codemodeCallHeadline,
  type ChatCodemodeCalls,
  type ChatCodemodeView,
} from "@fragno-private/design-system/chat-codemode-step";
import type { IconName } from "@fragno-private/design-system/icon";
import { LabeledSection } from "@fragno-private/design-system/labeled-section";
import { ScrollablePre } from "@fragno-private/design-system/scrollable-pre";
import { useState } from "react";

import type { ToolCallPart } from "./agent-turn";
import type { PiToolCallArtifact } from "./assistant-runtime";
import {
  getCodemodeCallsDetail,
  getCodemodeResultDetails,
  isCodemodeTool,
  type CodemodeResultDetails,
} from "./codemode-result";
import { getCodeArgument, formatJson } from "./tool-arguments";
import { ToolResultContent } from "./tool-result-content";
import { ToolArgumentsBlock } from "./tool-result-details";
import { ToolWorkspaceSelector, type ToolWorkspaceSelectorOption } from "./tool-workspace-selector";
import type { SessionWorkspaceNavigation } from "./workspace-context";
import { generatedUiWorkspaceId } from "./workspace-model";

const ordinaryResultPresentation: BackofficeUiParseResult = { kind: "ordinary" };

const TOOL_ICONS: Record<string, IconName> = {
  bash: "terminal",
  write: "edit-3",
  edit: "edit-3",
};

export type ToolCallPresentation = ReturnType<typeof toolCallPresentation>;

/** How a tool call reads in the chat: what ran, and what it produced. */
export function toolCallPresentation(part: ToolCallPart) {
  const artifact = (part.artifact ?? null) as PiToolCallArtifact | null;
  const draftTool = artifact?.draftTool ?? null;
  const completedToolResult = artifact?.completedToolResult ?? null;
  const codemode = isCodemodeTool(part.toolName);
  const codemodeDetails = codemode ? getCodemodeResultDetails(completedToolResult?.details) : null;
  const resultPresentation = codemodeDetails?.hasResult
    ? parseBackofficeUiResult(codemodeDetails.result)
    : ordinaryResultPresentation;
  const running =
    part.status.type === "running" || Boolean(draftTool && draftTool.status !== "done");
  // A running codemode call reports its run's calls so far; its result keeps the final ones.
  const callsDetail = codemode
    ? (codemodeDetails?.calls ?? getCodemodeCallsDetail(draftTool?.partialDetails))
    : null;
  const calls: ChatCodemodeCalls | null =
    callsDetail === null
      ? null
      : {
          startedAt: new Date(callsDetail.startedAt),
          items: callsDetail.items.map((call, index) => ({ ...call, id: String(index) })),
          unrecorded: callsDetail.omitted,
        };
  return {
    draftTool,
    completedToolResult,
    codemode,
    codemodeDetails,
    calls,
    // The model is still writing the program: the harness has not started the tool yet.
    writingCode: codemode && running && (draftTool === null || draftTool.status === "starting"),
    resultPresentation,
    running,
    failed: !running && Boolean(completedToolResult?.isError),
    label: part.toolName,
  };
}

/** What a running tool call is doing, for the header of its turn, down to the call its code makes. */
export function toolHeadline({ codemode, calls, writingCode, label }: ToolCallPresentation) {
  if (!codemode) {
    return `Running ${label}`;
  }
  const running = calls?.items.filter((call) => call.status === "running") ?? [];
  const newest = running.at(-1);
  if (newest === undefined) {
    return writingCode ? "Writing code" : "Running codemode";
  }
  const headline = codemodeCallHeadline(newest.subject);
  return running.length === 1 ? headline : `${headline} and ${running.length - 1} more`;
}

export function toolWorkspaceOptions(
  part: ToolCallPart,
  { resultPresentation }: ToolCallPresentation,
  navigation: SessionWorkspaceNavigation | null,
): ToolWorkspaceSelectorOption[] {
  if (!navigation) {
    return [];
  }
  const generatedUiItemId = generatedUiWorkspaceId(part.toolCallId);
  return resultPresentation.kind === "valid" && navigation.hasItem(generatedUiItemId)
    ? [{ id: generatedUiItemId, label: "Interface" }]
    : [];
}

const SUMMARY_ARGUMENTS = ["query", "pattern", "command", "url", "path", "name"];

/** A hint of what a tool call did: the first line of the code it ran, or its main argument. */
function argumentSummary(args: Record<string, unknown>) {
  const code = getCodeArgument(args)
    ?.code.split("\n")
    .map((codeLine) => codeLine.trim())
    .find((codeLine) => codeLine.length > 0 && !/^(?:\/\/|async\b.*=>\s*\{?$)/.test(codeLine));
  const argument =
    code ??
    SUMMARY_ARGUMENTS.map((key) => args[key]).find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  return argument === undefined
    ? null
    : argument.length > 60
      ? `${argument.slice(0, 59)}…`
      : argument;
}

/** A codemode run's result, with its raw value one click away when it is not an interface. */
function CodemodeResult({
  presentation: { completedToolResult, resultPresentation },
  codemodeDetails,
}: {
  presentation: ToolCallPresentation;
  codemodeDetails: CodemodeResultDetails;
}) {
  const [expanded, setExpanded] = useState(false);
  if (completedToolResult === null) {
    return null;
  }
  const canExpand = codemodeDetails.hasResult && resultPresentation.kind === "ordinary";
  return (
    <div className="space-y-2">
      {canExpand ? (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            onClick={() => {
              setExpanded((current) => !current);
            }}
          >
            {expanded ? "Hide raw" : "Show raw"}
          </Button>
        </div>
      ) : null}
      <ToolResultContent
        expanded={canExpand && expanded}
        hasRawResult={codemodeDetails.hasResult}
        parsedResult={resultPresentation}
        rawResult={codemodeDetails.result}
        result={completedToolResult}
        useCodemodeFormatting
      />
    </div>
  );
}

function codemodeViews(
  part: ToolCallPart,
  presentation: ToolCallPresentation,
  codemodeDetails: CodemodeResultDetails,
): ChatCodemodeView[] {
  const { completedToolResult, draftTool } = presentation;
  const views: ChatCodemodeView[] = [
    { label: "Code", content: <ToolArgumentsBlock rawText={part.argsText} value={part.args} /> },
  ];
  if (completedToolResult !== null) {
    views.push({
      label: completedToolResult.isError ? "Error" : "Result",
      content: <CodemodeResult presentation={presentation} codemodeDetails={codemodeDetails} />,
    });
  } else if (draftTool?.partialResult !== undefined) {
    views.push({
      label: "Output",
      content: <ScrollablePre>{formatJson(draftTool.partialResult)}</ScrollablePre>,
    });
  }
  if (codemodeDetails.logs.length > 0) {
    views.push({
      label: "Logs",
      content: <ScrollablePre>{codemodeDetails.logs.join("\n")}</ScrollablePre>,
    });
  }
  return views;
}

export function ToolCallStep({
  part,
  presentation,
  workspaceOptions,
}: {
  part: ToolCallPart;
  presentation: ToolCallPresentation;
  workspaceOptions: readonly ToolWorkspaceSelectorOption[];
}) {
  const { draftTool, completedToolResult, codemodeDetails, calls, running, failed, label } =
    presentation;
  const durationMs = completedToolResult?.durationMs ?? null;
  const actions =
    workspaceOptions.length === 0 ? null : (
      <ToolWorkspaceSelector options={workspaceOptions} toolLabel={label} labelled={false} />
    );

  if (codemodeDetails !== null) {
    return (
      <ChatCodemodeStep
        state={running ? "running" : failed ? "failed" : "done"}
        detail={
          presentation.writingCode
            ? "writing code…"
            : calls !== null && calls.items.length > 0
              ? null
              : argumentSummary(part.args)
        }
        calls={calls}
        durationMs={durationMs}
        views={codemodeViews(part, presentation, codemodeDetails)}
        actions={actions}
      />
    );
  }

  return (
    <ChatActivityStep
      icon={failed ? "alert-triangle" : (TOOL_ICONS[part.toolName] ?? "tool")}
      state={running ? "running" : failed ? "failed" : "done"}
      title={label}
      detail={argumentSummary(part.args)}
      durationMs={durationMs}
      actions={actions}
    >
      <ToolArgumentsBlock rawText={part.argsText} value={part.args} />
      {draftTool?.partialResult !== undefined ? (
        <LabeledSection label="Live result">
          <ScrollablePre>{formatJson(draftTool.partialResult)}</ScrollablePre>
        </LabeledSection>
      ) : null}
      {completedToolResult ? (
        <LabeledSection label={completedToolResult.isError ? "Error" : "Result"}>
          <ToolResultContent
            expanded={false}
            hasRawResult={false}
            parsedResult={ordinaryResultPresentation}
            rawResult={undefined}
            result={completedToolResult}
            useCodemodeFormatting={false}
          />
        </LabeledSection>
      ) : null}
    </ChatActivityStep>
  );
}
