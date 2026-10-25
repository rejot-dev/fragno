import {
  parseBackofficeUiResult,
  type BackofficeUiParseResult,
} from "@fragno-private/backoffice-ui/result";
import { Button } from "@fragno-private/design-system/button";
import { ChatActivityStep } from "@fragno-private/design-system/chat-activity";
import type { IconName } from "@fragno-private/design-system/icon";
import { LabeledSection } from "@fragno-private/design-system/labeled-section";
import { ScrollablePre } from "@fragno-private/design-system/scrollable-pre";
import { SectionDisclosure } from "@fragno-private/design-system/section-disclosure";
import { useState } from "react";

import type { ToolCallPart } from "./agent-turn";
import type { PiToolCallArtifact } from "./assistant-runtime";
import { getCodemodeResultDetails, isCodemodeTool } from "./codemode-result";
import { getCodeArgument, formatJson, getLoadedSkillName, getReadPath } from "./tool-arguments";
import { ToolResultContent } from "./tool-result-content";
import { ToolArgumentsBlock } from "./tool-result-details";
import { ToolWorkspaceSelector, type ToolWorkspaceSelectorOption } from "./tool-workspace-selector";
import type { SessionWorkspaceNavigation } from "./workspace-context";
import { generatedUiWorkspaceId } from "./workspace-model";

const ordinaryResultPresentation: BackofficeUiParseResult = { kind: "ordinary" };

const TOOL_ICONS: Record<string, IconName> = {
  codemode: "code",
  execCodeMode: "code",
  bash: "terminal",
  read: "file-text",
  write: "edit-3",
  edit: "edit-3",
};

export type ToolCallPresentation = ReturnType<typeof toolCallPresentation>;

/** How a tool call reads in the chat: what ran, and what it produced. */
export function toolCallPresentation(part: ToolCallPart) {
  const artifact = (part.artifact ?? null) as PiToolCallArtifact | null;
  const draftTool = artifact?.draftTool ?? null;
  const completedToolResult = artifact?.completedToolResult ?? null;
  const loadedSkillName = getLoadedSkillName({
    argumentsValue: part.args,
    completedToolResult,
    name: part.toolName,
  });
  const readPath =
    part.toolName === "read"
      ? (getReadPath(part.args) ?? getReadPath(completedToolResult?.details))
      : null;
  const codemodeDetails = isCodemodeTool(part.toolName)
    ? getCodemodeResultDetails(completedToolResult?.details)
    : null;
  const resultPresentation = codemodeDetails?.hasResult
    ? parseBackofficeUiResult(codemodeDetails.result)
    : ordinaryResultPresentation;
  const running =
    part.status.type === "running" || Boolean(draftTool && draftTool.status !== "done");
  return {
    draftTool,
    completedToolResult,
    codemodeDetails,
    resultPresentation,
    loadedSkillName,
    readPath,
    running,
    failed: !running && Boolean(completedToolResult?.isError),
    label: loadedSkillName ? "Skill loaded" : part.toolName,
  };
}

/** What a running tool call is doing, for the header of its turn. */
export function toolHeadline({ loadedSkillName, label }: ToolCallPresentation) {
  return loadedSkillName ? `Loading the ${loadedSkillName} skill` : `Running ${label}`;
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

/** The terms a search looked for, and where when it was narrowed. */
function searchSummary(args: Record<string, unknown>) {
  const { keywords, glob } = args;
  if (!Array.isArray(keywords) || keywords.length === 0) {
    return undefined;
  }
  const terms = keywords
    .filter((keyword): keyword is string => typeof keyword === "string")
    .map((keyword) => JSON.stringify(keyword))
    .join(" ");
  return typeof glob === "string" ? `${terms} in ${glob}` : terms;
}

/**
 * A hint of what a tool call did: the first line of the code it ran, the terms it searched for,
 * or its main argument, such as a path.
 */
function argumentSummary(args: Record<string, unknown>) {
  const code = getCodeArgument(args)
    ?.code.split("\n")
    .map((codeLine) => codeLine.trim())
    .find((codeLine) => codeLine.length > 0 && !/^(?:\/\/|async\b.*=>\s*\{?$)/.test(codeLine));
  const argument =
    code ??
    searchSummary(args) ??
    SUMMARY_ARGUMENTS.map((key) => args[key]).find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  return argument === undefined
    ? null
    : argument.length > 60
      ? `${argument.slice(0, 59)}…`
      : argument;
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
  const {
    draftTool,
    completedToolResult,
    codemodeDetails,
    resultPresentation,
    loadedSkillName,
    readPath,
    running,
    failed,
    label,
  } = presentation;
  const hasTaggedGeneratedUi = resultPresentation.kind !== "ordinary";
  const canExpandOrdinaryResult =
    (codemodeDetails?.hasResult ?? false) && resultPresentation.kind === "ordinary";
  const [resultExpanded, setResultExpanded] = useState(false);

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
        hasRawResult={codemodeDetails?.hasResult ?? false}
        parsedResult={resultPresentation}
        rawResult={codemodeDetails?.result}
        result={completedToolResult}
        useCodemodeFormatting={codemodeDetails !== null}
      />
    </LabeledSection>
  ) : null;

  const partialResult =
    draftTool?.partialResult !== undefined ? (
      <ScrollablePre>{formatJson(draftTool.partialResult)}</ScrollablePre>
    ) : null;
  const logs =
    codemodeDetails && codemodeDetails.logs.length > 0 ? (
      <ScrollablePre>{codemodeDetails.logs.join("\n")}</ScrollablePre>
    ) : null;

  return (
    <ChatActivityStep
      icon={
        failed
          ? "alert-triangle"
          : loadedSkillName
            ? "book-open"
            : (TOOL_ICONS[part.toolName] ?? "tool")
      }
      state={running ? "running" : failed ? "failed" : "done"}
      title={label}
      detail={loadedSkillName ?? readPath ?? argumentSummary(part.args)}
      durationMs={completedToolResult?.durationMs ?? null}
      outlined={loadedSkillName !== null}
      actions={
        workspaceOptions.length === 0 ? null : (
          <ToolWorkspaceSelector options={workspaceOptions} toolLabel={label} labelled={false} />
        )
      }
    >
      {hasTaggedGeneratedUi && completedToolResult ? (
        <>
          {completedResultSection}
          <SectionDisclosure label="Code">
            <ToolArgumentsBlock rawText={part.argsText} value={part.args} />
          </SectionDisclosure>
          {partialResult ? (
            <SectionDisclosure label="Live result">{partialResult}</SectionDisclosure>
          ) : null}
          {logs ? <SectionDisclosure label="Logs">{logs}</SectionDisclosure> : null}
        </>
      ) : (
        <>
          <ToolArgumentsBlock rawText={part.argsText} value={part.args} />
          {partialResult ? (
            <LabeledSection label="Live result">{partialResult}</LabeledSection>
          ) : null}
          {logs ? <LabeledSection label="Logs">{logs}</LabeledSection> : null}
          {completedResultSection}
        </>
      )}
    </ChatActivityStep>
  );
}
