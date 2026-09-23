import {
  scoreSummarySentenceIds,
  selectSummarySentenceIds,
  type SummarySentenceSelection,
} from "./select-summary-sentences.js";
import { buildSummarySentencePool } from "./sentence-representations.js";

const MMR_RELEVANCE_WEIGHTS = [0.55, 0.65, 0.75, 0.85] as const;
const PERTURBATION_STRENGTHS = [0, 0.015, 0.03, 0.05] as const;

/** Extractive search-space options; maxInputSentences must be between 1 and 100. */
export type GenerateCandidatesOptions = {
  maxInputSentences: number;
  candidates: number;
  summarySentences: readonly number[];
};

/** One extractive candidate with zero-based source IDs and a non-classifier heuristic score. */
export type CandidateSummary = {
  sentenceIds: number[];
  text: string;
  generationScore: number;
};

type GeneratedCandidate = CandidateSummary & {
  identity: string;
};

function assertPositiveInteger(value: number, optionName: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`Summary candidate generation: ${optionName} must be a positive integer`);
  }
}

function validateCandidateGenerationOptions(options: GenerateCandidatesOptions): void {
  assertPositiveInteger(options.maxInputSentences, "maxInputSentences");
  if (options.maxInputSentences > 100) {
    throw new RangeError("Summary candidate generation: maxInputSentences must not exceed 100");
  }

  assertPositiveInteger(options.candidates, "candidates");
  if (options.summarySentences.length === 0) {
    throw new RangeError(
      "Summary candidate generation: summarySentences must contain at least one sentence count",
    );
  }
  for (const sentenceCount of options.summarySentences) {
    assertPositiveInteger(sentenceCount, "each summarySentences value");
  }
}

function normalizedSummarySentenceCounts(summarySentences: readonly number[]): number[] {
  return [...new Set(summarySentences)].toSorted((left, right) => left - right);
}

function selectionForAttempt(
  attempt: number,
  summarySentenceCounts: readonly number[],
  seedRankCount: number,
): SummarySentenceSelection {
  let variant = attempt;
  const targetSentenceCount = summarySentenceCounts[variant % summarySentenceCounts.length];
  variant = Math.floor(variant / summarySentenceCounts.length);
  const relevanceWeight = MMR_RELEVANCE_WEIGHTS[variant % MMR_RELEVANCE_WEIGHTS.length];
  variant = Math.floor(variant / MMR_RELEVANCE_WEIGHTS.length);
  const seedRank = variant % seedRankCount;
  variant = Math.floor(variant / seedRankCount);
  const perturbationStrength = PERTURBATION_STRENGTHS[variant % PERTURBATION_STRENGTHS.length];

  return {
    targetSentenceCount,
    relevanceWeight,
    seedRank,
    perturbationStrength,
    perturbationSeed: attempt,
  };
}

/** Generates deterministic, diverse extractive summary candidates for an external classifier. */
export function generateCandidates(
  text: string,
  options: GenerateCandidatesOptions,
): CandidateSummary[] {
  validateCandidateGenerationOptions(options);
  const normalizedText = text.trim();
  if (normalizedText.length === 0) {
    return [];
  }

  const pool = buildSummarySentencePool(normalizedText, options.maxInputSentences);
  if (pool.sentences.length === 0) {
    return [];
  }

  const summarySentenceCounts = normalizedSummarySentenceCounts(options.summarySentences);
  const seedRankCount = Math.min(5, pool.sentences.length);
  const candidatesByIdentity = new Map<string, GeneratedCandidate>();
  const sentencesById = new Map(pool.sentences.map((sentence) => [sentence.id, sentence]));
  const maximumAttempts = options.candidates * 30 + 100;

  for (
    let attempt = 0;
    attempt < maximumAttempts && candidatesByIdentity.size < options.candidates;
    attempt += 1
  ) {
    const sentenceIds = selectSummarySentenceIds(
      pool,
      selectionForAttempt(attempt, summarySentenceCounts, seedRankCount),
    );
    const identity = sentenceIds.join(",");
    if (candidatesByIdentity.has(identity)) {
      continue;
    }

    candidatesByIdentity.set(identity, {
      identity,
      sentenceIds,
      text: sentenceIds.map((sentenceId) => sentencesById.get(sentenceId)!.text).join(" "),
      generationScore: scoreSummarySentenceIds(pool, sentenceIds),
    });
  }

  return [...candidatesByIdentity.values()]
    .toSorted(
      (left, right) =>
        right.generationScore - left.generationScore || left.identity.localeCompare(right.identity),
    )
    .map(({ sentenceIds, text: candidateText, generationScore }) => ({
      sentenceIds,
      text: candidateText,
      generationScore,
    }));
}
