import { expect, test } from "vitest";

import { TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";

import type { CandidateSummary } from "./generate-summary-candidates.js";
import {
  createTypeSafeSummaryCandidateEvaluator,
  rankSummaryCandidates,
  type SummaryCandidateEvaluation,
  type SummaryCandidateEvaluationBatch,
  type SummaryCandidateEvaluator,
} from "./score-summary-candidates-with-typesafe.js";

const ARTICLE = "A complete article used by every candidate evaluation.";

class FixedSummaryCandidateEvaluator implements SummaryCandidateEvaluator {
  readonly evaluatedCandidateSets: CandidateSummary[][] = [];
  private readonly evaluationsByText: ReadonlyMap<string, SummaryCandidateEvaluation>;

  constructor(evaluationsByText: ReadonlyMap<string, SummaryCandidateEvaluation>) {
    this.evaluationsByText = evaluationsByText;
  }

  async evaluateSummaryCandidates({
    article,
    candidates,
  }: {
    article: string;
    candidates: readonly CandidateSummary[];
  }): Promise<SummaryCandidateEvaluationBatch> {
    if (article !== ARTICLE) {
      throw new Error("Fixed summary candidate evaluator received an unexpected article");
    }
    this.evaluatedCandidateSets.push([...candidates]);

    return {
      evaluations: candidates.map((candidate) => {
        const evaluation = this.evaluationsByText.get(candidate.text);
        if (!evaluation) {
          throw new Error(`Fixed summary candidate evaluator has no result for: ${candidate.text}`);
        }
        return evaluation;
      }),
      rawResponse: null,
    };
  }
}

function candidateSummary(
  text: string,
  sentenceId: number,
  generationScore: number,
): CandidateSummary {
  return {
    sentenceIds: [sentenceId],
    text,
    generationScore,
  };
}

function summaryEvaluation(
  importance: number,
  coverage: number,
  coherence: number,
): SummaryCandidateEvaluation {
  return {
    model: "jev-test",
    importance: { score: importance, confidence: 0.8 },
    coverage: { score: coverage, confidence: 0.8 },
    coherence: { score: coherence, confidence: 0.8 },
  };
}

test("sends every candidate to TypeSafe in one API request", async () => {
  const candidates = [
    candidateSummary("First candidate summary.", 0, 0.8),
    candidateSummary("Second candidate summary.", 1, 0.7),
  ];
  const requests: Array<{
    state: { article: string; candidates: Array<{ id: number; text: string }> };
    questions: Record<string, unknown>;
  }> = [];
  const localTypeSafeFetch: Fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as (typeof requests)[number];
    requests.push(request);
    const answers = Object.fromEntries(
      Object.keys(request.questions).map((questionId) => [
        questionId,
        {
          type: "score",
          score: 3,
          confidence: 1,
          legend: { 0: "low", 1: "partial", 2: "strong", 3: "complete" },
          probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 },
        },
      ]),
    );

    return new Response(
      JSON.stringify({
        model: "jev-test",
        answers,
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const evaluator = createTypeSafeSummaryCandidateEvaluator(
    new TypeSafeClient({ apiKey: "test-key", fetch: localTypeSafeFetch }),
  );

  const evaluationBatch = await evaluator.evaluateSummaryCandidates({
    article: ARTICLE,
    candidates,
  });

  expect(requests).toHaveLength(1);
  expect(requests[0]!.state.candidates.map((candidate) => candidate.text)).toEqual([
    "First candidate summary.",
    "Second candidate summary.",
  ]);
  expect(Object.keys(requests[0]!.questions)).toHaveLength(6);
  expect(evaluationBatch.evaluations).toHaveLength(2);
  expect(evaluationBatch.evaluations.map((evaluation) => evaluation.importance.score)).toEqual([
    1, 1,
  ]);
  expect(evaluationBatch.rawResponse).toMatchObject({
    model: "jev-test",
    usage: { input_tokens: 100, output_tokens: 10 },
  });
});

test("ranks candidates by the weighted TypeSafe summary judgments", async () => {
  const candidates = [
    candidateSummary("Important but narrow summary.", 0, 0.9),
    candidateSummary("Balanced summary of the major points.", 1, 0.7),
    candidateSummary("Broad and especially coherent summary.", 2, 0.8),
  ];
  const evaluator = new FixedSummaryCandidateEvaluator(
    new Map([
      [candidates[0]!.text, summaryEvaluation(0.9, 0.5, 0.8)],
      [candidates[1]!.text, summaryEvaluation(0.8, 0.9, 0.7)],
      [candidates[2]!.text, summaryEvaluation(0.7, 0.8, 0.95)],
    ]),
  );

  const ranking = await rankSummaryCandidates(ARTICLE, candidates, evaluator);

  expect(evaluator.evaluatedCandidateSets).toHaveLength(1);
  expect(evaluator.evaluatedCandidateSets[0]).toEqual(candidates);
  expect(ranking.rankedCandidates.map((candidate) => candidate.candidate.text))
    .toMatchInlineSnapshot(`
    [
      "Balanced summary of the major points.",
      "Broad and especially coherent summary.",
      "Important but narrow summary.",
    ]
  `);
  expect(ranking.rankedCandidates.map((candidate) => candidate.classifierScore)).toEqual([
    0.81, 0.78, 0.76,
  ]);
});
