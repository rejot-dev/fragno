import type { AgentMessage } from "@earendil-works/pi-agent-core";

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

export const formatJson = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const formatJsonString = (value: string) => {
  try {
    return formatJson(JSON.parse(value));
  } catch {
    return value;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

export const getCodeArgument = (value: unknown) => {
  if (!isRecord(value) || typeof value.code !== "string") {
    return null;
  }

  const { code, ...rest } = value;
  return { code, rest };
};

const getReadPath = (value: unknown) => {
  if (!isRecord(value) || typeof value.path !== "string") {
    return null;
  }
  return value.path;
};

const getSkillNameFromPath = (path: string | null | undefined) => {
  if (!path) {
    return null;
  }

  const pathSegments = path.split(/[\\/]+/).filter(Boolean);
  if (pathSegments.at(-1) !== "SKILL.md") {
    return null;
  }

  return pathSegments.at(-2) ?? null;
};

export const getLoadedSkillName = ({
  argumentsValue,
  completedToolResult,
  name,
}: {
  argumentsValue: unknown;
  completedToolResult: ToolResultMessage | null;
  name: string;
}) => {
  if (name !== "read" || !completedToolResult || completedToolResult.isError) {
    return null;
  }

  const resultPath = getReadPath(completedToolResult.details);
  const argumentPath = getReadPath(argumentsValue);
  return getSkillNameFromPath(resultPath ?? argumentPath);
};

export const formatExecCodeModeExpandedResult = (result: ToolResultMessage) => {
  if (!isRecord(result.details)) {
    return null;
  }

  const lines: string[] = [];
  if (Array.isArray(result.details.logs)) {
    lines.push(...result.details.logs.filter((line): line is string => typeof line === "string"));
  }

  if ("result" in result.details && result.details.result !== undefined) {
    const resultText =
      typeof result.details.result === "string"
        ? formatJsonString(result.details.result)
        : formatJson(result.details.result);
    lines.push(resultText);
  }

  return lines.length > 0 ? lines.join("\n") : null;
};

const decodeStreamingJsonString = (value: string) => {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '"') {
      break;
    }
    if (char !== "\\") {
      result += char;
      continue;
    }

    const escaped = value[++index];
    switch (escaped) {
      case '"':
      case "\\":
      case "/":
        result += escaped;
        break;
      case "b":
        result += "\b";
        break;
      case "f":
        result += "\f";
        break;
      case "n":
        result += "\n";
        break;
      case "r":
        result += "\r";
        break;
      case "t":
        result += "\t";
        break;
      case "u": {
        const hex = value.slice(index + 1, index + 5);
        if (/^[\da-fA-F]{4}$/.test(hex)) {
          result += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
        }
        break;
      }
      case undefined:
        return result;
      default:
        result += escaped;
    }
  }
  return result;
};

const extractStreamingJsonStringField = (rawText: string | undefined, fieldNames: string[]) => {
  if (!rawText) {
    return null;
  }

  for (const fieldName of fieldNames) {
    const fieldStart = rawText.indexOf(JSON.stringify(fieldName));
    if (fieldStart === -1) {
      continue;
    }

    const colon = rawText.indexOf(":", fieldStart + fieldName.length + 2);
    if (colon === -1) {
      continue;
    }

    let valueStart = colon + 1;
    while (/\s/.test(rawText[valueStart] ?? "")) {
      valueStart++;
    }
    if (rawText[valueStart] !== '"') {
      continue;
    }

    return decodeStreamingJsonString(rawText.slice(valueStart + 1));
  }

  return null;
};

export const formatToolArgumentsDisplayText = ({
  rawText,
  value,
}: {
  rawText?: string;
  value: unknown;
}) => {
  const codeArgument = getCodeArgument(value);
  const streamingCode = extractStreamingJsonStringField(rawText, ["code"]);
  if (streamingCode && streamingCode.length >= (codeArgument ? codeArgument.code.length : 0)) {
    return streamingCode;
  }
  if (codeArgument) {
    return codeArgument.code;
  }
  return rawText && rawText.length > 0 ? rawText : formatJson(value);
};
