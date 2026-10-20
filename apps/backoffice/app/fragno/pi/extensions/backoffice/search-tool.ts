import { Type } from "typebox";
import { z } from "zod";

import { copyJson } from "@earendil-works/chord";
import { defineTool } from "@earendil-works/pi-durable";

import type { FileSearchMatch } from "@/file-collection/file-collection";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import {
  requirePiStateBackend,
  type BackofficeAgentContext,
} from "@/fragno/pi/agent/backoffice-agent-context";

const searchParametersSchema = Type.Object({
  keywords: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
    minItems: 1,
    maxItems: 8,
    description:
      "Distinctive words or identifiers, not sentences. A line matches when it contains any keyword, case-insensitively.",
  }),
  glob: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Path glob such as `/workspace/**` or `/static/skills/**`. Defaults to all files.",
    }),
  ),
  cursor: Type.Optional(
    Type.String({ description: "Continuation cursor from a previous search result." }),
  ),
});

// The agent gets one search behaviour; tuning knobs only invited unhelpful variations.
const SEARCH_OPTIONS = { contextBefore: 2, contextAfter: 2, maxMatches: 30 };

type SearchMatchWithLineText = FileSearchMatch & { lineText?: string };
type SearchMountPage = Awaited<ReturnType<BackofficeStateBackend["searchFiles"]>>["upload"];

// Both mounts fill a page, so `skip` counts mount matches already shown from the source page.
const searchMountCursorSchema = z.object({
  sourceCursor: z.string().optional(),
  skip: z.number().int().nonnegative(),
});
const searchCursorSchema = z.object({
  upload: searchMountCursorSchema.optional(),
  static: searchMountCursorSchema.optional(),
});
type SearchMountCursor = z.infer<typeof searchMountCursorSchema>;
type SearchCursor = z.infer<typeof searchCursorSchema>;

function decodeSearchCursor(cursor: string): SearchCursor {
  try {
    return searchCursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new Error("Invalid search cursor.");
  }
}

function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

const flattenSearchMountPage = (page: SearchMountPage): SearchMatchWithLineText[] =>
  page.results.flatMap((file) =>
    file.matches.map((match) => ({
      path: file.path,
      line: match.line,
      column: match.column,
      text: match.match,
      lineText: match.lineText,
      contextBefore: match.beforeLines ?? [],
      contextAfter: match.afterLines ?? [],
    })),
  );

const nextSearchMountCursor = (
  current: SearchMountCursor,
  page: SearchMountPage,
  pageMatchCount: number,
  consumedCount: number,
): SearchMountCursor | undefined => {
  const remainingInPage = Math.max(0, pageMatchCount - current.skip);
  if (consumedCount < remainingInPage) {
    return {
      ...(current.sourceCursor ? { sourceCursor: current.sourceCursor } : {}),
      skip: current.skip + consumedCount,
    };
  }
  if (page.hasMore && page.cursor) {
    return { sourceCursor: page.cursor, skip: 0 };
  }
  return undefined;
};

type SearchOutputLine = {
  line: number;
  column?: number;
  text: string;
  isMatch: boolean;
};

const formatSearchMatches = (matches: readonly SearchMatchWithLineText[]): string => {
  const blocks: Array<{
    path: string;
    start: number;
    end: number;
    lines: Map<number, SearchOutputLine>;
  }> = [];

  for (const match of matches) {
    const start = match.line - match.contextBefore.length;
    const end = match.line + match.contextAfter.length;
    const previousBlock = blocks.at(-1);
    const block =
      previousBlock?.path === match.path && start <= previousBlock.end + 1
        ? previousBlock
        : {
            path: match.path,
            start,
            end,
            lines: new Map<number, SearchOutputLine>(),
          };

    if (block !== previousBlock) {
      blocks.push(block);
    } else {
      block.end = Math.max(block.end, end);
    }

    match.contextBefore.forEach((text, index) => {
      const line = start + index;
      if (!block.lines.has(line)) {
        block.lines.set(line, { line, text, isMatch: false });
      }
    });

    const existingMatchLine = block.lines.get(match.line);
    block.lines.set(match.line, {
      line: match.line,
      column: Math.min(existingMatchLine?.column ?? match.column, match.column),
      text: match.lineText ?? match.text,
      isMatch: true,
    });

    match.contextAfter.forEach((text, index) => {
      const line = match.line + index + 1;
      if (!block.lines.has(line)) {
        block.lines.set(line, { line, text, isMatch: false });
      }
    });
  }

  return blocks
    .map((block) => {
      const lines = [...block.lines.values()]
        .sort((left, right) => left.line - right.line)
        .map((line) =>
          line.isMatch
            ? `> ${line.line}:${line.column} | ${line.text}`
            : `  ${line.line} | ${line.text}`,
        )
        .join("\n");
      return `${block.path}\n${lines}`;
    })
    .join("\n\n");
};

function formatSearchResult(
  keywords: readonly string[],
  glob: string,
  matches: readonly SearchMatchWithLineText[],
  cursor: string | undefined,
): string {
  const quotedKeywords = keywords.map((keyword) => JSON.stringify(keyword)).join(", ");
  const continuation = cursor ? ` Continue with cursor: ${JSON.stringify(cursor)}` : "";
  if (matches.length > 0) {
    return `${formatSearchMatches(matches)}${cursor ? `\n\nMore results may remain.${continuation}` : ""}`;
  }
  // A cursor without matches means the scan budget ran out before any file matched.
  return cursor
    ? `No matches for ${quotedKeywords} in the files scanned so far; more files remain.${continuation}`
    : `No matches for ${quotedKeywords} in ${glob}.`;
}

export function createSearchTool(agent: BackofficeAgentContext) {
  return defineTool({
    name: "search",
    description:
      "Search file contents in the current scope, including installed skills under /workspace and product guidance under /static.",
    parameters: searchParametersSchema,
    replay: "safe",
    async execute(params, api, context) {
      const turn = await agent.activeTurn(context);
      await turn.authorize();
      if (context.abortSignal?.aborted) {
        throw new Error("Search aborted.");
      }

      const state = requirePiStateBackend(
        turn.toolContext(`${agent.agentName}:${api.taskId}`, context),
      );
      const glob = params.glob ?? "**";
      const cursor = params.cursor === undefined ? undefined : decodeSearchCursor(params.cursor);
      const mountOptions = (mountCursor: SearchMountCursor) => ({
        ...SEARCH_OPTIONS,
        ...(mountCursor.sourceCursor ? { cursor: mountCursor.sourceCursor } : {}),
      });
      const result = await state.searchFiles(
        glob,
        params.keywords,
        cursor
          ? {
              ...(cursor.upload ? { upload: mountOptions(cursor.upload) } : {}),
              ...(cursor.static ? { static: mountOptions(cursor.static) } : {}),
            }
          : { upload: SEARCH_OPTIONS, static: SEARCH_OPTIONS },
      );
      const uploadCursor = cursor?.upload ?? { skip: 0 };
      const staticCursor = cursor?.static ?? { skip: 0 };
      const uploadPageMatches = flattenSearchMountPage(result.upload);
      const staticPageMatches = flattenSearchMountPage(result.static);
      const uploadMatches = uploadPageMatches.slice(uploadCursor.skip);
      const staticMatches = staticPageMatches.slice(staticCursor.skip);
      const matches: SearchMatchWithLineText[] = [...uploadMatches, ...staticMatches].slice(
        0,
        SEARCH_OPTIONS.maxMatches,
      );
      const consumedUploadMatches = Math.min(matches.length, uploadMatches.length);
      const nextUploadCursor = nextSearchMountCursor(
        uploadCursor,
        result.upload,
        uploadPageMatches.length,
        consumedUploadMatches,
      );
      const nextStaticCursor = nextSearchMountCursor(
        staticCursor,
        result.static,
        staticPageMatches.length,
        matches.length - consumedUploadMatches,
      );
      const nextCursor =
        nextUploadCursor || nextStaticCursor
          ? encodeSearchCursor({
              ...(nextUploadCursor ? { upload: nextUploadCursor } : {}),
              ...(nextStaticCursor ? { static: nextStaticCursor } : {}),
            })
          : undefined;

      return {
        output: [
          {
            type: "text",
            text: formatSearchResult(params.keywords, glob, matches, nextCursor),
          },
        ],
        details: copyJson({
          keywords: params.keywords,
          glob,
          matches,
          cursor: nextCursor ?? null,
        }),
      };
    },
  });
}
