import { score, type Questions, type ScoreResponse, type TypeSafeClient } from "@typesafe-ai/sdk";

import type { CandidateSummary } from "./generate-summary-candidates.js";

const IMPORTANCE_CRITERIA = [
  "The summary is dominated by minor or background details and does not convey the article's main subject.",
  "The summary identifies the main subject but gives substantial space to secondary details instead of the most important information.",
  "The summary captures the main subject and important facts, with only a notable central point or emphasis missing.",
  "The summary captures the article's main point and the facts most important for understanding it.",
] as const;

const COVERAGE_CRITERIA = [
  "The summary repeats one narrow detail or misses nearly all of the article's major points.",
  "The summary covers one important aspect but leaves most other major points unrepresented.",
  "The summary covers several distinct important aspects but leaves a notable gap in the article's overall picture.",
  "The summary gives balanced coverage of the article's distinct major points within its short length.",
] as const;

const COHERENCE_CRITERIA = [
  "The selected sentences are repetitive, disjointed, or misleading without omitted context.",
  "The summary is understandable but has substantial repetition, abrupt transitions, or context gaps.",
  "The summary is mostly coherent and non-redundant, with only a minor transition or context problem.",
  "The summary is concise, coherent, non-redundant, and understandable without reading the full article.",
] as const;

const TOP_SCORE_LEVEL = 3;

type SummaryQualityDimension = {
  score: number;
  confidence: number;
};

type SummaryQualityQuestionIds = {
  importance: string;
  coverage: string;
  coherence: string;
};

/** TypeSafe judgments for one candidate summary, normalized to zero through one. */
export type SummaryCandidateEvaluation = {
  model: string;
  importance: SummaryQualityDimension;
  coverage: SummaryQualityDimension;
  coherence: SummaryQualityDimension;
};

/** One candidate ranked by TypeSafe summary-quality judgments. */
export type RankedSummaryCandidate = {
  candidate: CandidateSummary;
  classifierScore: number;
  evaluation: SummaryCandidateEvaluation;
};

/** All normalized evaluations plus the classifier response preserved without interpretation. */
export type SummaryCandidateEvaluationBatch = {
  evaluations: SummaryCandidateEvaluation[];
  rawResponse: unknown;
};

/** Ranked candidates plus the classifier response preserved without interpretation. */
export type RankedSummaryCandidates = {
  rankedCandidates: RankedSummaryCandidate[];
  rawResponse: unknown;
};

/** Evaluates a complete candidate set against one source article in one classifier operation. */
export type SummaryCandidateEvaluator = {
  evaluateSummaryCandidates(input: {
    article: string;
    candidates: readonly CandidateSummary[];
  }): Promise<SummaryCandidateEvaluationBatch>;
};

function normalizedScore(scoreValue: number): number {
  return scoreValue / TOP_SCORE_LEVEL;
}

function qualityQuestionIds(candidateIndex: number): SummaryQualityQuestionIds {
  return {
    importance: `candidate_${candidateIndex}_importance`,
    coverage: `candidate_${candidateIndex}_coverage`,
    coherence: `candidate_${candidateIndex}_coherence`,
  };
}

function addCandidateQualityQuestions(
  questions: Questions,
  candidateIndex: number,
): SummaryQualityQuestionIds {
  const candidatePath = `candidates[${candidateIndex}].text`;
  const questionIds = qualityQuestionIds(candidateIndex);
  questions[questionIds.importance] = score(
    `How well does \`${candidatePath}\` preserve the most important information from \`article\`?`,
    IMPORTANCE_CRITERIA,
  );
  questions[questionIds.coverage] = score(
    `How broadly does \`${candidatePath}\` cover the distinct major points in \`article\`?`,
    COVERAGE_CRITERIA,
  );
  questions[questionIds.coherence] = score(
    `How well does \`${candidatePath}\` read as a concise standalone summary of \`article\`?`,
    COHERENCE_CRITERIA,
  );
  return questionIds;
}

function summaryQualityDimension(answer: ScoreResponse): SummaryQualityDimension {
  return {
    score: normalizedScore(answer.score),
    confidence: answer.confidence,
  };
}

/** Creates a TypeSafe evaluator that scores every candidate with one System One API request. */
export function createTypeSafeSummaryCandidateEvaluator(
  client: TypeSafeClient,
): SummaryCandidateEvaluator {
  return {
    async evaluateSummaryCandidates({ article, candidates }) {
      const questions: Questions = {};
      const questionIds = candidates.map((_, candidateIndex) =>
        addCandidateQualityQuestions(questions, candidateIndex),
      );
      const response = await client.systemOne({
        state: {
          article,
          candidates: candidates.map((candidate, candidateIndex) => ({
            id: candidateIndex,
            text: candidate.text,
          })),
        },
        questions,
      });
      const answers = response.answers as Readonly<Record<string, ScoreResponse>>;

      return {
        evaluations: questionIds.map((candidateQuestionIds) => ({
          model: response.model,
          importance: summaryQualityDimension(answers[candidateQuestionIds.importance]),
          coverage: summaryQualityDimension(answers[candidateQuestionIds.coverage]),
          coherence: summaryQualityDimension(answers[candidateQuestionIds.coherence]),
        })),
        rawResponse: response,
      };
    },
  };
}

function calculateClassifierScore(evaluation: SummaryCandidateEvaluation): number {
  return (
    0.5 * evaluation.importance.score +
    0.3 * evaluation.coverage.score +
    0.2 * evaluation.coherence.score
  );
}

/** Scores all candidates once and ranks them by TypeSafe quality, then generation score. */
export async function rankSummaryCandidates(
  article: string,
  candidates: readonly CandidateSummary[],
  evaluator: SummaryCandidateEvaluator,
): Promise<RankedSummaryCandidates> {
  const evaluationBatch = await evaluator.evaluateSummaryCandidates({ article, candidates });
  if (evaluationBatch.evaluations.length !== candidates.length) {
    throw new Error(
      "Summary candidate ranking: evaluator returned a different number of evaluations than candidates",
    );
  }

  const rankedCandidates = candidates
    .map((candidate, candidateIndex) => {
      const evaluation = evaluationBatch.evaluations[candidateIndex];
      return {
        candidate,
        classifierScore: calculateClassifierScore(evaluation),
        evaluation,
      };
    })
    .toSorted(
      (left, right) =>
        right.classifierScore - left.classifierScore ||
        right.candidate.generationScore - left.candidate.generationScore ||
        left.candidate.sentenceIds.join(",").localeCompare(right.candidate.sentenceIds.join(",")),
    );

  return {
    rankedCandidates,
    rawResponse: evaluationBatch.rawResponse,
  };
}
