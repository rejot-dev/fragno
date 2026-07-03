export type TextIndexOptions = {
  enabled?: boolean;
  minTermLength?: number;
  maxTermLength?: number;
};

export type TextIndexTerm = {
  term: string;
  positions: number[];
  count: number;
};

export type BuiltTextIndex = {
  contentHash: string;
  byteLength: number;
  terms: TextIndexTerm[];
};

export type StateSearchOptions = {
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  contextBefore?: number;
  contextAfter?: number;
  maxMatches?: number;
};

export type StateTextMatch = {
  path: string;
  line: number;
  column: number;
  startOffset: number;
  endOffset: number;
  text: string;
  contextBefore: string[];
  contextAfter: string[];
};

const DEFAULT_MIN_TERM_LENGTH = 2;
const DEFAULT_MAX_TERM_LENGTH = 128;
const TEXT_CONTENT_TYPES = [
  "application/javascript",
  "application/json",
  "application/typescript",
  "application/xml",
  "application/x-javascript",
  "application/x-typescript",
  "image/svg+xml",
];

const tokenPattern = /[\p{L}\p{N}_$]+/gu;

export const normalizeTextIndexTerm = (term: string) => term.normalize("NFKC").toLowerCase();

export const extractTextIndexTerms = (
  text: string,
  options: Pick<TextIndexOptions, "minTermLength" | "maxTermLength"> = {},
): string[] => {
  const minTermLength = options.minTermLength ?? DEFAULT_MIN_TERM_LENGTH;
  const maxTermLength = options.maxTermLength ?? DEFAULT_MAX_TERM_LENGTH;
  const terms: string[] = [];

  for (const match of text.matchAll(tokenPattern)) {
    const rawTerm = match[0];
    if (rawTerm.length < minTermLength || rawTerm.length > maxTermLength) {
      continue;
    }
    terms.push(normalizeTextIndexTerm(rawTerm));
  }

  return terms;
};

export const shouldIndexContentType = (contentType: string): boolean => {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return normalized.startsWith("text/") || TEXT_CONTENT_TYPES.includes(normalized);
};

const hashBytes = (bytes: Uint8Array) => {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }

  return hash.toString(16).padStart(16, "0");
};

export const buildTextIndex = (
  bytes: Uint8Array,
  options: TextIndexOptions = {},
): BuiltTextIndex => {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const minTermLength = options.minTermLength ?? DEFAULT_MIN_TERM_LENGTH;
  const maxTermLength = options.maxTermLength ?? DEFAULT_MAX_TERM_LENGTH;
  const terms = new Map<string, number[]>();

  for (const match of text.matchAll(tokenPattern)) {
    const rawTerm = match[0];
    if (rawTerm.length < minTermLength || rawTerm.length > maxTermLength) {
      continue;
    }

    const term = normalizeTextIndexTerm(rawTerm);
    const positions = terms.get(term);
    if (positions) {
      positions.push(match.index ?? 0);
      continue;
    }

    terms.set(term, [match.index ?? 0]);
  }

  return {
    contentHash: hashBytes(bytes),
    byteLength: bytes.byteLength,
    terms: Array.from(terms.entries()).map(([term, positions]) => ({
      term,
      positions,
      count: positions.length,
    })),
  };
};

const isWordCharacter = (value: string) => /[\p{L}\p{N}_$]/u.test(value);

const isWholeWordMatch = (text: string, startOffset: number, endOffset: number) => {
  const before = startOffset > 0 ? text[startOffset - 1] : undefined;
  const after = endOffset < text.length ? text[endOffset] : undefined;
  return (!before || !isWordCharacter(before)) && (!after || !isWordCharacter(after));
};

const getLineStarts = (text: string): number[] => {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
};

const getLineForOffset = (lineStarts: number[], offset: number) => {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = lineStarts[middle] ?? 0;
    const next = lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY;
    if (offset >= start && offset < next) {
      return middle;
    }
    if (offset < start) {
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return lineStarts.length - 1;
};

const getLines = (text: string) => text.split(/\r?\n/);

export const searchTextContent = (
  path: string,
  text: string,
  query: string,
  options: StateSearchOptions = {},
): StateTextMatch[] => {
  const maxMatches = options.maxMatches ?? 50;
  if (maxMatches <= 0 || query.length === 0) {
    return [];
  }

  if (options.regex) {
    throw new Error("TEXT_SEARCH_REGEX_UNSUPPORTED");
  }

  const haystack = options.caseSensitive ? text : text.toLocaleLowerCase();
  const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
  const lineStarts = getLineStarts(text);
  const lines = getLines(text);
  const matches: StateTextMatch[] = [];
  let searchOffset = 0;

  while (matches.length < maxMatches) {
    const startOffset = haystack.indexOf(needle, searchOffset);
    if (startOffset === -1) {
      break;
    }

    const endOffset = startOffset + needle.length;
    searchOffset = Math.max(endOffset, startOffset + 1);

    if (options.wholeWord && !isWholeWordMatch(text, startOffset, endOffset)) {
      continue;
    }

    const lineIndex = getLineForOffset(lineStarts, startOffset);
    const lineStart = lineStarts[lineIndex] ?? 0;
    const contextBefore = Math.max(0, options.contextBefore ?? 0);
    const contextAfter = Math.max(0, options.contextAfter ?? 0);

    matches.push({
      path,
      line: lineIndex + 1,
      column: startOffset - lineStart + 1,
      startOffset,
      endOffset,
      text: text.slice(startOffset, endOffset),
      contextBefore: lines.slice(Math.max(0, lineIndex - contextBefore), lineIndex),
      contextAfter: lines.slice(lineIndex + 1, lineIndex + 1 + contextAfter),
    });
  }

  return matches;
};

export const getStaticGlobPrefix = (glob: string) => {
  const normalized = glob.replace(/^\/+/, "");
  const wildcardIndex = normalized.search(/[!*?[{]/);
  const staticPart = wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex);
  const slashIndex = staticPart.lastIndexOf("/");
  if (wildcardIndex === -1) {
    return staticPart;
  }
  return slashIndex === -1 ? "" : staticPart.slice(0, slashIndex + 1);
};

const escapeRegex = (value: string) => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");

export const globToRegExp = (glob: string) => {
  const normalized = glob.replace(/^\/+/, "");
  let pattern = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      pattern += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      pattern += "[^/]*";
      continue;
    }
    if (char === "?") {
      pattern += "[^/]";
      continue;
    }
    pattern += escapeRegex(char ?? "");
  }
  pattern += "$";
  return new RegExp(pattern);
};
