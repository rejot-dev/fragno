import { Type } from "typebox";

import { copyJson } from "@earendil-works/chord";
import { defineTool } from "@earendil-works/pi-durable";

import type { FileSearchMatch } from "@/file-collection/file-collection";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import {
  requirePiStateBackend,
  type BackofficeAgentContext,
} from "@/fragno/pi/agent/backoffice-agent-context";

const searchParametersSchema = Type.Object({
  query: Type.String({ minLength: 1, description: "Text to search for." }),
  glob: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Workspace Upload key glob to search. Defaults to all files.",
    }),
  ),
  caseSensitive: Type.Optional(Type.Boolean()),
  wholeWord: Type.Optional(Type.Boolean()),
  contextBefore: Type.Optional(Type.Number({ minimum: 0, maximum: 200 })),
  contextAfter: Type.Optional(Type.Number({ minimum: 0, maximum: 200 })),
  maxMatches: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(
    Type.Object({
      upload: Type.Optional(Type.String()),
      static: Type.Optional(Type.String()),
    }),
  ),
});

type SearchMatchWithLineText = FileSearchMatch & { lineText?: string };
type SearchMountPage = Awaited<ReturnType<BackofficeStateBackend["searchFiles"]>>["upload"];
type SearchMountCursor = { sourceCursor?: string; skip: number };

const SEARCH_MOUNT_CURSOR_PREFIX = "pi-search:";

const decodeSearchMountCursor = (cursor: string | undefined): SearchMountCursor => {
  if (!cursor) {
    return { skip: 0 };
  }
  if (!cursor.startsWith(SEARCH_MOUNT_CURSOR_PREFIX)) {
    return { sourceCursor: cursor, skip: 0 };
  }

  const parsed = JSON.parse(cursor.slice(SEARCH_MOUNT_CURSOR_PREFIX.length)) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("skip" in parsed) ||
    !Number.isInteger(parsed.skip) ||
    (parsed.skip as number) < 0 ||
    ("sourceCursor" in parsed &&
      parsed.sourceCursor !== undefined &&
      typeof parsed.sourceCursor !== "string")
  ) {
    throw new Error("Invalid search cursor.");
  }
  return parsed as SearchMountCursor;
};

const encodeSearchMountCursor = (cursor: SearchMountCursor): string =>
  `${SEARCH_MOUNT_CURSOR_PREFIX}${JSON.stringify(cursor)}`;

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
): string | undefined => {
  const remainingInPage = Math.max(0, pageMatchCount - current.skip);
  if (consumedCount < remainingInPage) {
    return encodeSearchMountCursor({
      ...(current.sourceCursor ? { sourceCursor: current.sourceCursor } : {}),
      skip: current.skip + consumedCount,
    });
  }
  if (page.hasMore && page.cursor) {
    return encodeSearchMountCursor({ sourceCursor: page.cursor, skip: 0 });
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

export function createSearchTool(agent: BackofficeAgentContext) {
  return defineTool({
    name: "search",
    description: "Search file contents in the current scope.",
    parameters: searchParametersSchema,
    replay: "safe",
    async execute(params, api, context) {
      await agent.authorize();
      if (context.abortSignal?.aborted) {
        throw new Error("Search aborted.");
      }

      const state = requirePiStateBackend(
        agent.toolContext(`${agent.sessionId}:${api.taskId}`, context),
      );
      const maxMatches = params.maxMatches ?? 50;
      const searchOptions = {
        caseSensitive: params.caseSensitive,
        wholeWord: params.wholeWord,
        contextBefore: params.contextBefore,
        contextAfter: params.contextAfter,
        maxMatches,
      };
      const uploadCursor = decodeSearchMountCursor(params.cursor?.upload);
      const staticCursor = decodeSearchMountCursor(params.cursor?.static);
      const requestedMounts = params.cursor
        ? {
            ...(params.cursor.upload
              ? {
                  upload: {
                    ...searchOptions,
                    ...(uploadCursor.sourceCursor ? { cursor: uploadCursor.sourceCursor } : {}),
                  },
                }
              : {}),
            ...(params.cursor.static
              ? {
                  static: {
                    ...searchOptions,
                    ...(staticCursor.sourceCursor ? { cursor: staticCursor.sourceCursor } : {}),
                  },
                }
              : {}),
          }
        : { upload: searchOptions, static: searchOptions };
      const result = await state.searchFiles(params.glob ?? "**", params.query, requestedMounts);
      const uploadPageMatches = flattenSearchMountPage(result.upload);
      const staticPageMatches = flattenSearchMountPage(result.static);
      const uploadMatches = uploadPageMatches.slice(uploadCursor.skip);
      const staticMatches = staticPageMatches.slice(staticCursor.skip);
      const matches: SearchMatchWithLineText[] = [...uploadMatches, ...staticMatches].slice(
        0,
        maxMatches,
      );
      const consumedUploadMatches = Math.min(matches.length, uploadMatches.length);
      const consumedStaticMatches = matches.length - consumedUploadMatches;
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
        consumedStaticMatches,
      );
      const cursor = {
        ...(nextUploadCursor ? { upload: nextUploadCursor } : {}),
        ...(nextStaticCursor ? { static: nextStaticCursor } : {}),
      };
      const hasMore = {
        upload: nextUploadCursor !== undefined,
        static: nextStaticCursor !== undefined,
      };
      const continuation =
        hasMore.upload || hasMore.static
          ? `\n\nMore files are available. Continue with cursor: ${JSON.stringify(cursor)}`
          : "";

      return {
        content: [
          {
            type: "text",
            text: `${formatSearchMatches(matches)}${continuation}`,
          },
        ],
        details: copyJson({
          query: params.query,
          glob: params.glob ?? "**",
          matches,
          cursor,
          hasMore,
        }),
      };
    },
  });
}
