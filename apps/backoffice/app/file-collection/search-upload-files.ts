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
// One call keeps scanning candidates until its page is full, so a search whose matches are rare
// stops here and hands back a cursor instead of scanning the whole workspace.
const MAX_CANDIDATE_PAGES = 10;
const MAX_SCANNED_BYTES = 60 * 1024 * 1024;

const candidateCursorSchema = z.object({
  pass: z.number().int().nonnegative(),
  indexCursor: z.string().optional(),
});

const uploadSearchCursorSchema = z.object({
  version: z.literal(4),
  fingerprint: z.string(),
  candidateCursor: candidateCursorSchema.optional(),
  candidateOffset: z.number().int().nonnegative(),
  searchOffset: z.number().int().nonnegative(),
});

type UploadSearchCursor = z.infer<typeof uploadSearchCursorSchema>;
type CandidateCursor = z.infer<typeof candidateCursorSchema>;

export type UploadFileSearchResult = {
  matches: readonly FileSearchMatch[];
  cursor?: string;
  hasMore: boolean;
};

export async function searchUploadFiles(input: {
  routes: UploadRouteCaller;
  provider: string;
  glob: string;
  keywords: readonly string[];
  options?: FileSearchOptions;
  cursor?: string;
}): Promise<UploadFileSearchResult> {
  const options = input.options ?? {};
  if (input.keywords.length === 0 || (options.maxMatches ?? 50) <= 0) {
    return { matches: [], hasMore: false };
  }

  const fingerprint = createFileSearchFingerprint(input.glob, input.keywords, options);
  let position: UploadSearchCursor = {
    version: 4,
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

  const maxMatches = Math.min(
    MAX_HYDRATION_MATCHES,
    Math.max(1, Math.trunc(options.maxMatches ?? 50)),
  );
  const matches: FileSearchMatch[] = [];
  let candidatePages = 0;
  let scannedBytes = 0;
  const pageEnd = (): UploadFileSearchResult => ({
    matches,
    cursor: Buffer.from(JSON.stringify(position)).toString("base64url"),
    hasMore: true,
  });

  while (true) {
    const candidatePage = await findCandidates(input, position.candidateCursor);
    candidatePages += 1;

    while (position.candidateOffset < candidatePage.candidates.length) {
      if (matches.length >= maxMatches || scannedBytes >= MAX_SCANNED_BYTES) {
        return pageEnd();
      }

      const remainingMatches = maxMatches - matches.length;
      const hydrated = await hydrateMatches(input, {
        candidateKeys: selectHydrationBatch(
          candidatePage.candidates.slice(position.candidateOffset),
          remainingMatches,
          MAX_HYDRATION_BYTES,
        ),
        excludedTerms: candidatePage.excludedTerms,
        searchOffset: position.searchOffset,
        maxMatches: remainingMatches,
      });
      if (hydrated.consumedCandidates === 0 && hydrated.matches.length === 0) {
        throw new Error("Upload file search hydration made no progress.");
      }

      matches.push(...hydrated.matches);
      scannedBytes += hydrated.scannedBytes;
      position = {
        ...position,
        candidateOffset: position.candidateOffset + hydrated.consumedCandidates,
        searchOffset: hydrated.nextSearchOffset ?? 0,
      };
    }

    if (!candidatePage.cursor) {
      return { matches, hasMore: false };
    }
    position = {
      version: 4,
      fingerprint,
      candidateCursor: candidatePage.cursor,
      candidateOffset: 0,
      searchOffset: 0,
    };
    if (
      matches.length >= maxMatches ||
      candidatePages >= MAX_CANDIDATE_PAGES ||
      scannedBytes >= MAX_SCANNED_BYTES
    ) {
      return pageEnd();
    }
  }
}

/**
 * The candidates one hydration should scan: about as many as fill the remaining matches, and no
 * more than its byte budget scans, since hydration reads the content of every candidate it gets.
 */
function selectHydrationBatch(
  candidates: readonly { key: string; count: number; byteLength: number }[],
  maxMatches: number,
  maxBytes: number,
): string[] {
  const batch: string[] = [];
  let estimatedMatches = 0;
  let bytes = 0;
  for (const candidate of candidates) {
    const candidateEstimate = Math.max(1, candidate.count);
    if (
      batch.length > 0 &&
      (estimatedMatches + candidateEstimate > maxMatches || bytes + candidate.byteLength > maxBytes)
    ) {
      break;
    }
    batch.push(candidate.key);
    estimatedMatches += candidateEstimate;
    bytes += candidate.byteLength;
    if (estimatedMatches >= maxMatches) {
      break;
    }
  }
  return batch;
}

async function findCandidates(
  input: Parameters<typeof searchUploadFiles>[0],
  cursor: CandidateCursor | undefined,
) {
  const response = await input.routes("POST", "/files/search", {
    body: {
      provider: input.provider,
      glob: input.glob,
      keywords: [...input.keywords],
      maxCandidateFiles: MAX_CANDIDATE_FILES,
      ...(cursor ? { cursor } : {}),
    },
  });
  if (response.type === "error") {
    throw new UploadFileSearchError(response.error.message, {
      code: response.error.code,
      status: response.status,
    });
  }
  if (response.type !== "json") {
    throw new Error(`Upload file search route returned an unexpected ${response.type} response.`);
  }
  return response.data;
}

async function hydrateMatches(
  input: Parameters<typeof searchUploadFiles>[0],
  batch: {
    candidateKeys: string[];
    excludedTerms: string[];
    searchOffset: number;
    maxMatches: number;
  },
) {
  const response = await input.routes("POST", "/files/search/hydrate", {
    body: {
      provider: input.provider,
      candidateKeys: batch.candidateKeys,
      keywords: [...input.keywords],
      excludedTerms: batch.excludedTerms,
      options: { ...input.options, maxMatches: batch.maxMatches },
      ...(batch.searchOffset > 0 ? { searchOffset: batch.searchOffset } : {}),
      maxBytes: MAX_HYDRATION_BYTES,
    },
  });
  if (response.type === "error") {
    throw new UploadFileSearchError(response.error.message, {
      code: response.error.code,
      status: response.status,
    });
  }
  if (response.type !== "json") {
    throw new Error(
      `Upload file search hydration route returned an unexpected ${response.type} response.`,
    );
  }
  if (response.data.truncated && response.data.nextSearchOffset === undefined) {
    throw new Error("Upload file search hydration omitted its next search offset.");
  }
  return response.data;
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
