import type { SummarySentencePool } from "./sentence-representations.js";

/** Parameters for one deterministic maximal marginal relevance selection. */
export type SummarySentenceSelection = {
  targetSentenceCount: number;
  relevanceWeight: number;
  seedRank: number;
  perturbationStrength: number;
  perturbationSeed: number;
};

function deterministicPerturbation(sentenceId: number, seed: number): number {
  let value = Math.imul(sentenceId + 1, 0x9e3779b1) ^ Math.imul(seed + 1, 0x85ebca6b);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  return (value >>> 0) / 0xffff_ffff;
}

function perturbedRelevance(
  relevance: number,
  sentenceId: number,
  selection: SummarySentenceSelection,
): number {
  const centeredPerturbation =
    deterministicPerturbation(sentenceId, selection.perturbationSeed) * 2 - 1;
  return Math.max(
    0,
    Math.min(1, relevance + centeredPerturbation * selection.perturbationStrength),
  );
}

function compareSentenceIndexesByRelevance(
  leftIndex: number,
  rightIndex: number,
  pool: SummarySentencePool,
  selection: SummarySentenceSelection,
): number {
  const leftSentence = pool.sentences[leftIndex];
  const rightSentence = pool.sentences[rightIndex];
  return (
    perturbedRelevance(rightSentence.relevance, rightSentence.id, selection) -
      perturbedRelevance(leftSentence.relevance, leftSentence.id, selection) ||
    leftSentence.id - rightSentence.id
  );
}

/** Selects sentence IDs with maximal marginal relevance and returns them in document order. */
export function selectSummarySentenceIds(
  pool: SummarySentencePool,
  selection: SummarySentenceSelection,
): number[] {
  const targetSentenceCount = Math.min(selection.targetSentenceCount, pool.sentences.length);
  if (targetSentenceCount === 0) {
    return [];
  }

  const rankedSentenceIndexes = pool.sentences
    .map((_, sentenceIndex) => sentenceIndex)
    .toSorted((leftIndex, rightIndex) =>
      compareSentenceIndexesByRelevance(leftIndex, rightIndex, pool, selection),
    );
  const selectedIndexes = [
    rankedSentenceIndexes[selection.seedRank % rankedSentenceIndexes.length],
  ];
  const remainingIndexes = new Set(rankedSentenceIndexes);
  remainingIndexes.delete(selectedIndexes[0]);

  while (selectedIndexes.length < targetSentenceCount) {
    let bestSentenceIndex = -1;
    let bestMmrScore = Number.NEGATIVE_INFINITY;
    let bestRelevance = Number.NEGATIVE_INFINITY;

    for (const sentenceIndex of remainingIndexes) {
      const sentence = pool.sentences[sentenceIndex];
      const relevance = perturbedRelevance(sentence.relevance, sentence.id, selection);
      const maximumRedundancy = Math.max(
        ...selectedIndexes.map(
          (selectedSentenceIndex) => pool.similarities[sentenceIndex][selectedSentenceIndex],
        ),
      );
      const mmrScore =
        selection.relevanceWeight * relevance - (1 - selection.relevanceWeight) * maximumRedundancy;

      if (
        mmrScore > bestMmrScore ||
        (mmrScore === bestMmrScore && relevance > bestRelevance) ||
        (mmrScore === bestMmrScore &&
          relevance === bestRelevance &&
          sentence.id < (pool.sentences[bestSentenceIndex]?.id ?? Number.POSITIVE_INFINITY))
      ) {
        bestSentenceIndex = sentenceIndex;
        bestMmrScore = mmrScore;
        bestRelevance = relevance;
      }
    }

    selectedIndexes.push(bestSentenceIndex);
    remainingIndexes.delete(bestSentenceIndex);
  }

  return selectedIndexes
    .map((sentenceIndex) => pool.sentences[sentenceIndex].id)
    .toSorted((leftId, rightId) => leftId - rightId);
}

/** Scores a selected extractive summary by sentence relevance and pairwise non-redundancy. */
export function scoreSummarySentenceIds(
  pool: SummarySentencePool,
  sentenceIds: readonly number[],
): number {
  const sentenceIndexes = sentenceIds.map((sentenceId) =>
    pool.sentences.findIndex((sentence) => sentence.id === sentenceId),
  );
  const averageRelevance =
    sentenceIndexes.reduce(
      (total, sentenceIndex) => total + pool.sentences[sentenceIndex].relevance,
      0,
    ) / sentenceIndexes.length;

  let similarityTotal = 0;
  let pairCount = 0;
  for (let leftIndex = 0; leftIndex < sentenceIndexes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sentenceIndexes.length; rightIndex += 1) {
      similarityTotal += pool.similarities[sentenceIndexes[leftIndex]][sentenceIndexes[rightIndex]];
      pairCount += 1;
    }
  }
  const averageRedundancy = pairCount === 0 ? 0 : similarityTotal / pairCount;

  return 0.7 * averageRelevance + 0.3 * (1 - averageRedundancy);
}
