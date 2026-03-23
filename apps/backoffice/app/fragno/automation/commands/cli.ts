import type {
  AutomationCommandExecutionResult,
  AutomationCommandOptionSpec,
  AutomationCommandOutputOptions,
  AutomationCommandSpec,
} from "./types";

export type ParsedCliTokens = {
  options: Map<string, string | boolean | string[]>;
  positionals: string[];
};

const kebabToCamel = (value: string) =>
  value.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());

const getSingleOption = (
  options: ParsedCliTokens["options"],
  name: string,
): string | boolean | undefined => {
  const value = options.get(name);
  if (Array.isArray(value)) {
    return value.at(-1);
  }
  return value;
};

const appendOptionValue = (
  options: ParsedCliTokens["options"],
  name: string,
  value: string | boolean,
) => {
  const existing = options.get(name);
  if (typeof existing === "undefined") {
    options.set(name, value);
    return;
  }

  if (Array.isArray(existing)) {
    existing.push(String(value));
    return;
  }

  options.set(name, [String(existing), String(value)]);
};

const getPrintableValue = (data: unknown, selector: string) => {
  if (!selector.trim()) {
    return undefined;
  }

  let current = data;
  for (const segment of selector.split(".")) {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    const key = kebabToCamel(segment.trim());
    if (!key || !(key in current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return current;
};

const stringifyOutput = (value: unknown) => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  return JSON.stringify(value);
};

export const ensureTrailingNewline = (value: string) =>
  value.endsWith("\n") ? value : `${value}\n`;

export const parseCliTokens = (args: string[]): ParsedCliTokens => {
  const options = new Map<string, string | boolean | string[]>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      appendOptionValue(
        options,
        withoutPrefix.slice(0, equalsIndex),
        withoutPrefix.slice(equalsIndex + 1),
      );
      continue;
    }

    const nextToken = args[index + 1];
    if (typeof nextToken === "undefined" || nextToken.startsWith("--")) {
      appendOptionValue(options, withoutPrefix, true);
      continue;
    }

    appendOptionValue(options, withoutPrefix, nextToken);
    index += 1;
  }

  return { options, positionals };
};

export const readStringOption = (
  parsed: ParsedCliTokens,
  name: string,
  required = false,
): string | undefined => {
  const value = getSingleOption(parsed.options, name);
  if (typeof value === "boolean") {
    throw new Error(`--${name} requires a value`);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (required) {
    throw new Error(`Missing required option --${name}`);
  }
  return undefined;
};

export const readIntegerOption = (
  parsed: ParsedCliTokens,
  name: string,
  required = false,
): number | undefined => {
  const raw = readStringOption(parsed, name, required);
  if (typeof raw === "undefined") {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`--${name} must be an integer`);
  }

  return value;
};

export const readJsonOption = (
  parsed: ParsedCliTokens,
  name: string,
): Record<string, unknown> | undefined => {
  const raw = readStringOption(parsed, name);
  if (typeof raw === "undefined") {
    return undefined;
  }

  try {
    const result = JSON.parse(raw);

    if (typeof result !== "object" || result === null) {
      throw new Error(`--${name} must be a JSON object`);
    }

    return result;
  } catch {
    throw new Error(`--${name} must be valid JSON`);
  }
};

export const readOutputOptions = (parsed: ParsedCliTokens): AutomationCommandOutputOptions => {
  const print = readStringOption(parsed, "print");
  const format = readStringOption(parsed, "format");

  if (typeof format === "undefined") {
    return { format: "text", ...(print ? { print } : {}) };
  }

  if (format !== "text" && format !== "json") {
    throw new Error(`Unsupported --format value '${format}'`);
  }

  return { format, ...(print ? { print } : {}) };
};

export const assertNoPositionals = (parsed: ParsedCliTokens, commandName: string) => {
  if (parsed.positionals.length > 0) {
    throw new Error(`${commandName} does not accept positional arguments`);
  }
};

export const normalizeExecutionResult = (
  rawResult: AutomationCommandExecutionResult | unknown,
): AutomationCommandExecutionResult => {
  if (
    rawResult &&
    typeof rawResult === "object" &&
    ("data" in rawResult ||
      "stdout" in rawResult ||
      "stderr" in rawResult ||
      "exitCode" in rawResult)
  ) {
    return rawResult as AutomationCommandExecutionResult;
  }

  return { data: rawResult };
};

export const formatCommandStdout = (
  outputOptions: { format?: "text" | "json"; print?: string },
  result: AutomationCommandExecutionResult,
) => {
  if (typeof result.stdout === "string") {
    return result.stdout;
  }

  if (typeof result.data === "undefined") {
    return "";
  }

  if (outputOptions.print) {
    const value = getPrintableValue(result.data, outputOptions.print);
    if (typeof value === "undefined") {
      return "";
    }
    return ensureTrailingNewline(stringifyOutput(value));
  }

  if (outputOptions.format === "json") {
    return ensureTrailingNewline(JSON.stringify(result.data));
  }

  return "";
};

const formatCommandOptionLine = (option: AutomationCommandOptionSpec) => {
  const name = `--${option.name}`;
  const value = option.valueRequired ? ` <${option.valueName ?? "value"}>` : "";
  const required = option.required ? "" : " [optional]";
  return `${name}${value} ${required}`.trimEnd();
};

export const hasHelpOption = (parsed: ParsedCliTokens) => parsed.options.has("help");

export const describeCommandOption = (option: AutomationCommandOptionSpec) => {
  const optionLine = formatCommandOptionLine(option);
  const description = option.required ? `${option.description} (required)` : option.description;

  return `${optionLine.padEnd(36)}${description}`;
};

export const buildCommandHelp = (spec: AutomationCommandSpec) => {
  const outputLines: string[] = [];

  outputLines.push(`${spec.name}`);
  outputLines.push("");
  outputLines.push(spec.help.summary);
  outputLines.push("");
  outputLines.push(`Usage: ${spec.name} [options]`);
  outputLines.push("");
  outputLines.push("Options:");

  for (const option of spec.help.options) {
    outputLines.push(`  ${describeCommandOption(option)}`);
  }

  outputLines.push(
    `  ${describeCommandOption({
      name: "help",
      description: "Show this help text",
      valueRequired: false,
      valueName: "",
    })}`,
  );

  outputLines.push(
    `  ${describeCommandOption({
      name: "print",
      description: "Extract a nested JSON field (kebab-case path) from command result",
      valueRequired: true,
      valueName: "selector",
      required: false,
    })}`,
  );

  outputLines.push(
    `  ${describeCommandOption({
      name: "format",
      description: "Output format: text (default) or json",
      valueRequired: true,
      valueName: "format",
    })}`,
  );

  if (spec.help.examples && spec.help.examples.length > 0) {
    outputLines.push("");
    outputLines.push("Examples:");
    for (const example of spec.help.examples) {
      outputLines.push(`  ${example}`);
    }
  }

  return `${outputLines.join("\n")}\n`;
};
