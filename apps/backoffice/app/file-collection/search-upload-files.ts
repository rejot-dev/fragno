import { z } from "zod";

import type { UploadRouteCaller } from "@/fragno/upload-server";

import {
  createFileSearchFingerprint,
  type FileSearchMatch,
  type FileSearchOptions,
} from "./file-collection";

const MAX_CANDIDATE_FILES = 100;
const MAX_HYDRATION_BYTES = 30 * 1024 * 1024;
const MAX_HYDRATION_MATCHES = 500;

const uploadSearchCursorSchema = z.object({
  version: z.literal(3),
  fingerprint: z.string(),
  serverCursor: z.string().optional(),
  candidateOffset: z.number().int().nonnegative(),
  searchOffset: z.number().int().nonnegative(),
});

type UploadSearchCursor = z.infer<typeof uploadSearchCursorSchema>;

export type UploadFileSearchResult = {
  matches: readonly FileSearchMatch[];
  cursor?: string;
  hasMoreCandidates: boolean;
};

export async function searchUploadFiles(input: {
  routes: UploadRouteCaller;
  provider: string;
  glob: string;
  query: string;
  options?: FileSearchOptions;
  cursor?: string;
}): Promise<UploadFileSearchResult> {
  const options = input.options ?? {};
  if (!input.query || (options.maxMatches ?? 50) <= 0) {
    return { matches: [], hasMoreCandidates: false };
  }

  const fingerprint = createFileSearchFingerprint(input.glob, input.query, options);
  let position: UploadSearchCursor = {
    version: 3,
    fingerprint,
    candidateOffset: 0,
    searchOffset: 0,
  };
  if (input.cursor) {
    try {
      position = uploadSearchCursorSchema.parse(
        JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
      );
      if (position.fingerprint !== fingerprint) {
        throw new Error("Search changed.");
      }
    } catch {
      throw new Error("Invalid Upload file search cursor.");
    }
  }

  const candidateResponse = await input.routes("POST", "/files/search", {
    body: {
      provider: input.provider,
      glob: input.glob,
      query: input.query,
      maxCandidateFiles: MAX_CANDIDATE_FILES,
      ...(position.serverCursor ? { cursor: position.serverCursor } : {}),
    },
  });

  if (candidateResponse.type === "error") {
    throw new UploadFileSearchError(candidateResponse.error.message, {
      code: candidateResponse.error.code,
      status: candidateResponse.status,
    });
  }
  if (candidateResponse.type !== "json") {
    throw new Error(
      `Upload file search route returned an unexpected ${candidateResponse.type} response.`,
    );
  }

  const candidatePage = candidateResponse.data;
  if (candidatePage.hasMoreCandidates && !candidatePage.cursor) {
    throw new Error("Upload file search response omitted its next cursor.");
  }

  const maxMatches = Math.min(
    MAX_HYDRATION_MATCHES,
    Math.max(1, Math.trunc(options.maxMatches ?? 50)),
  );
  const remainingCandidates = candidatePage.candidates.slice(position.candidateOffset);
  const candidates = [];
  let estimatedMatches = 0;
  for (const candidate of remainingCandidates) {
    const candidateEstimate = Math.max(1, candidate.count);
    if (candidates.length > 0 && estimatedMatches + candidateEstimate > maxMatches) {
      break;
    }
    candidates.push(candidate);
    estimatedMatches += candidateEstimate;
    if (estimatedMatches >= maxMatches) {
      break;
    }
  }

  if (candidates.length === 0) {
    const hasMoreCandidates = candidatePage.hasMoreCandidates;
    return {
      matches: [],
      ...(hasMoreCandidates && candidatePage.cursor
        ? {
            cursor: Buffer.from(
              JSON.stringify({
                version: 3,
                fingerprint,
                serverCursor: candidatePage.cursor,
                candidateOffset: 0,
                searchOffset: 0,
              } satisfies UploadSearchCursor),
            ).toString("base64url"),
          }
        : {}),
      hasMoreCandidates,
    };
  }

  const hydrateResponse = await input.routes("POST", "/files/search/hydrate", {
    body: {
      provider: input.provider,
      candidateKeys: candidates.map((candidate) => candidate.key),
      query: input.query,
      options: {
        ...input.options,
        maxMatches,
      },
      ...(position.searchOffset > 0 ? { searchOffset: position.searchOffset } : {}),
      maxBytes: MAX_HYDRATION_BYTES,
    },
  });

  if (hydrateResponse.type === "error") {
    throw new UploadFileSearchError(hydrateResponse.error.message, {
      code: hydrateResponse.error.code,
      status: hydrateResponse.status,
    });
  }
  if (hydrateResponse.type !== "json") {
    throw new Error(
      `Upload file search hydration route returned an unexpected ${hydrateResponse.type} response.`,
    );
  }
  if (hydrateResponse.data.truncated && hydrateResponse.data.nextSearchOffset === undefined) {
    throw new Error("Upload file search hydration omitted its next search offset.");
  }

  const consumedCandidates = hydrateResponse.data.consumedCandidates;
  const nextCandidateOffset = position.candidateOffset + consumedCandidates;
  const nextSearchOffset = hydrateResponse.data.nextSearchOffset ?? 0;
  const hasCandidatesInPage = nextCandidateOffset < candidatePage.candidates.length;
  const hasMoreCandidates = hasCandidatesInPage || candidatePage.hasMoreCandidates;
  const nextPosition: UploadSearchCursor | undefined = hasCandidatesInPage
    ? {
        version: 3,
        fingerprint,
        serverCursor: position.serverCursor,
        candidateOffset: nextCandidateOffset,
        searchOffset: nextSearchOffset,
      }
    : candidatePage.hasMoreCandidates && candidatePage.cursor
      ? {
          version: 3,
          fingerprint,
          serverCursor: candidatePage.cursor,
          candidateOffset: 0,
          searchOffset: 0,
        }
      : undefined;

  return {
    matches: hydrateResponse.data.matches,
    ...(nextPosition
      ? {
          cursor: Buffer.from(JSON.stringify(nextPosition)).toString("base64url"),
        }
      : {}),
    hasMoreCandidates,
  };
}

export class UploadFileSearchError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, options: { code: string; status: number }) {
    super(message);
    this.name = "UploadFileSearchError";
    this.code = options.code;
    this.status = options.status;
  }
}
