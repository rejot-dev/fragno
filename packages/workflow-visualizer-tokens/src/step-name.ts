import type { StepNameTemplate } from "./model.ts";
import {
  isTriviaToken,
  staticStringValue,
  templateChunkText,
  type WorkflowToken,
} from "./tokenizer.ts";

type StepNamePart =
  | { kind: "text"; text: string }
  | { kind: "expression"; tokens: readonly WorkflowToken[] };

export type StepName =
  | { kind: "static"; label: string }
  | { kind: "template"; label: string; nameTemplate: StepNameTemplate };

/**
 * Reads a step name argument: a string, a template literal, or a `+` concatenation of both with
 * expressions. Dynamic names keep their static text so runtime step names can be matched to them.
 * Expressions that are themselves strings fold into the text, as after helper argument substitution.
 */
export function stepNameFromArgument(tokens: readonly WorkflowToken[]): StepName | undefined {
  const parts = nameParts(tokens.filter((token) => !isTriviaToken(token)));
  if (!parts || !parts.some((part) => part.kind === "text")) {
    return undefined;
  }

  const staticParts = [""];
  let label = "";
  let previousWasExpression = false;
  for (const part of parts) {
    if (part.kind === "text") {
      staticParts[staticParts.length - 1] += part.text;
      label += part.text;
      previousWasExpression = false;
      continue;
    }
    // Adjacent expressions fill one hole, just like adjacent template substitutions would.
    if (!previousWasExpression) {
      staticParts.push("");
    }
    previousWasExpression = true;
    label += `\${${part.tokens.map((token) => token.value).join("")}}`;
  }

  return staticParts.length === 1
    ? { kind: "static", label }
    : { kind: "template", label, nameTemplate: { staticParts } };
}

/** A token of a helper's source, with the helper whose parameter it refers to, if any. */
export interface ReferencedToken {
  token: WorkflowToken;
  helperParameterOf: string | null;
}

/**
 * Resolves the identifiers of an expression read where `helperParameterOwners` were in scope. Which
 * binding a name refers to is decided there, so a local that shadows a parameter keeps its value.
 */
export function referencedTokens(
  tokens: readonly WorkflowToken[],
  helperParameterOwners: ReadonlyMap<string, string>,
): ReferencedToken[] {
  const significant = tokens.filter((token) => !isTriviaToken(token));
  return significant.map((token, index) => {
    const previous = significant[index - 1]?.value;
    const reference = token.type === "IdentifierName" && previous !== "." && previous !== "?.";
    return {
      token,
      helperParameterOf: (reference && helperParameterOwners.get(token.value)) || null,
    };
  });
}

/**
 * Replaces references to a helper's parameters with the tokens the call passed, so a step named
 * after a parameter is named after the call's argument.
 */
export function substituteHelperArguments(
  tokens: readonly ReferencedToken[],
  helper: { id: string; parameters: ReadonlyArray<string | null> },
  callArguments: ReadonlyArray<readonly ReferencedToken[]>,
): ReferencedToken[] {
  return tokens.flatMap((reference) => {
    const parameterIndex =
      reference.helperParameterOf === helper.id
        ? helper.parameters.indexOf(reference.token.value)
        : -1;
    return callArguments[parameterIndex] ?? [reference];
  });
}

function nameParts(tokens: readonly WorkflowToken[]): StepNamePart[] | undefined {
  const [only] = tokens;
  const text = tokens.length === 1 && only ? staticStringValue(only) : undefined;
  if (text !== undefined) {
    return [{ kind: "text", text }];
  }
  return templateParts(tokens) ?? concatenationParts(tokens);
}

function templateParts(tokens: readonly WorkflowToken[]): StepNamePart[] | undefined {
  if (tokens[0]?.type !== "TemplateHead" || tokens.at(-1)?.type !== "TemplateTail") {
    return undefined;
  }

  const parts: StepNamePart[] = [];
  let substitution: WorkflowToken[] = [];
  let templateDepth = 0;
  for (const [index, token] of tokens.entries()) {
    const boundary =
      (token.type === "TemplateHead" && templateDepth === 0) ||
      ((token.type === "TemplateMiddle" || token.type === "TemplateTail") && templateDepth === 1);
    if (token.type === "TemplateHead") {
      templateDepth += 1;
    } else if (token.type === "TemplateTail") {
      templateDepth -= 1;
    }
    if (!boundary) {
      substitution.push(token);
      continue;
    }
    if (token.type === "TemplateHead" && index !== 0) {
      return undefined;
    }
    if (token.type !== "TemplateHead") {
      parts.push(...expressionParts(substitution));
      substitution = [];
    }
    if (token.type === "TemplateTail" && index !== tokens.length - 1) {
      return undefined;
    }
    parts.push({ kind: "text", text: templateChunkText(token) });
  }
  return templateDepth === 0 ? parts : undefined;
}

function concatenationParts(tokens: readonly WorkflowToken[]): StepNamePart[] | undefined {
  const operands: WorkflowToken[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (
      token.type === "TemplateHead" ||
      (token.type === "Punctuator" && "([{".includes(token.value))
    ) {
      depth += 1;
    } else if (
      token.type === "TemplateTail" ||
      (token.type === "Punctuator" && ")]}".includes(token.value))
    ) {
      depth -= 1;
    }
    if (depth === 0 && token.type === "Punctuator" && token.value === "+") {
      operands.push([]);
      continue;
    }
    operands.at(-1)?.push(token);
  }
  if (operands.length < 2 || operands.some((operand) => operand.length === 0)) {
    return undefined;
  }
  return operands.flatMap(expressionParts);
}

function expressionParts(tokens: readonly WorkflowToken[]): StepNamePart[] {
  return nameParts(tokens) ?? [{ kind: "expression", tokens }];
}
