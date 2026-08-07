import { parse } from "yaml";

export type FrontmatterDocument<T extends Record<string, unknown>> = {
  frontmatter: T;
  body: string;
};

export type FrontmatterParseResult<T extends Record<string, unknown>> =
  | { ok: true; value: FrontmatterDocument<T> }
  | { ok: false; error: Error };

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Frontmatter is parsed at a trusted file boundary and projected to the caller's schema type.
export function parseFrontmatter<T extends Record<string, unknown>>(
  content: string,
): FrontmatterParseResult<T> {
  try {
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized.startsWith("---\n")) {
      return { ok: true, value: { frontmatter: {} as T, body: normalized } };
    }

    const closingDelimiter = /\n---(?=\n|$)/g;
    closingDelimiter.lastIndex = 4;
    const endMatch = closingDelimiter.exec(normalized);
    if (!endMatch) {
      return { ok: true, value: { frontmatter: {} as T, body: normalized } };
    }

    const yamlString = normalized.slice(4, endMatch.index);
    const body = normalized.slice(endMatch.index + endMatch[0].length).trim();
    return { ok: true, value: { frontmatter: (parse(yamlString) ?? {}) as T, body } };
  } catch (error) {
    return { ok: false, error: toError(error) };
  }
}
