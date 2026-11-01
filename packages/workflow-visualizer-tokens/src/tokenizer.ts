import jsTokens, { type Token } from "js-tokens";

export type WorkflowToken = Token;

/** Tokenize source leniently. js-tokens yields input-covering tokens even for invalid source. */
export function tokenizeWorkflowSource(source: string): Iterable<WorkflowToken> {
  return jsTokens(source);
}

export function isTriviaToken(token: WorkflowToken): boolean {
  return (
    token.type === "WhiteSpace" ||
    token.type === "LineTerminatorSequence" ||
    token.type === "SingleLineComment" ||
    token.type === "MultiLineComment" ||
    token.type === "HashbangComment"
  );
}

export function tokenIsOpen(token: WorkflowToken): boolean {
  return "closed" in token && !token.closed;
}

export function staticStringValue(token: WorkflowToken): string | undefined {
  if (token.type !== "StringLiteral" && token.type !== "NoSubstitutionTemplate") {
    return undefined;
  }

  const quote = token.value[0];
  const hasClosingQuote = token.closed && token.value.at(-1) === quote;
  const body = token.value.slice(1, hasClosingQuote ? -1 : undefined);

  if (quote === '"' && token.closed) {
    try {
      return JSON.parse(token.value) as string;
    } catch {
      return decodeEscapes(body);
    }
  }

  return decodeEscapes(body);
}

/** The decoded text of one template chunk: a head, middle, or (possibly unclosed) tail. */
export function templateChunkText(token: WorkflowToken): string {
  const end = token.type === "TemplateTail" ? (tokenIsOpen(token) ? undefined : -1) : -2;
  return decodeEscapes(token.value.slice(1, end));
}

function decodeEscapes(value: string): string {
  return value.replace(
    /\\(?:\r\n|[\n\r\u2028\u2029]|u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|x([\da-fA-F]{2})|([^\n\r\u2028\u2029]))/g,
    (
      match,
      codePoint: string | undefined,
      unicode: string | undefined,
      hex: string | undefined,
      escapedCharacter: string | undefined,
    ) => {
      if (match === "\\\r\n" || /^\\[\n\r\u2028\u2029]$/.test(match)) {
        return "";
      }
      if (codePoint) {
        const parsedCodePoint = Number.parseInt(codePoint, 16);
        return parsedCodePoint <= 0x10ffff ? String.fromCodePoint(parsedCodePoint) : match;
      }
      if (unicode) {
        return String.fromCharCode(Number.parseInt(unicode, 16));
      }
      if (hex) {
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      if (!escapedCharacter) {
        return match;
      }
      return SIMPLE_ESCAPES[escapedCharacter] ?? escapedCharacter;
    },
  );
}

const SIMPLE_ESCAPES: Record<string, string> = {
  "\\": "\\",
  "'": "'",
  '"': '"',
  "`": "`",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "0": "\0",
};
