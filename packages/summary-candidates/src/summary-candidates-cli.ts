import { readFile } from "node:fs/promises";

import { TypeSafeClient } from "@typesafe-ai/sdk";

import { generateCandidates, type CandidateSummary } from "./generate-summary-candidates.js";
import {
  createTypeSafeSummaryCandidateEvaluator,
  rankSummaryCandidates,
  type RankedSummaryCandidate,
} from "./score-summary-candidates-with-typesafe.js";

const CLI_USAGE = `Generate extractive summary candidates and use TypeSafe Jev to show the best and worst.

USAGE:
  summary-candidates <article-file>
  cat article.txt | summary-candidates
  summary-candidates - < article.txt

ENVIRONMENT:
  TYPESAFE_JEV_API_KEY    TypeSafe API key used to score generated candidates

OPTIONS:
  --raw                   Print only the unprocessed TypeSafe JSON response
  -h, --help              Show this help`;

const CANDIDATE_GENERATION_OPTIONS = {
  maxInputSentences: 100,
  candidates: 20,
  summarySentences: [4],
} as const;

async function readStandardInput(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let article = "";
  for await (const chunk of process.stdin) {
    article += chunk;
  }
  return article;
}

async function readArticle(articlePath: string | undefined): Promise<string> {
  if (articlePath === "-" || articlePath === undefined) {
    if (articlePath === undefined && process.stdin.isTTY) {
      throw new Error(
        "Summary candidates CLI: provide an article file or pipe article text to stdin",
      );
    }
    return readStandardInput();
  }

  return readFile(articlePath, "utf8");
}

function uniqueCandidateTexts(candidates: readonly CandidateSummary[]): CandidateSummary[] {
  const candidatesByText = new Map<string, CandidateSummary>();
  for (const candidate of candidates) {
    if (!candidatesByText.has(candidate.text)) {
      candidatesByText.set(candidate.text, candidate);
    }
  }
  return [...candidatesByText.values()];
}

function formatPercentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatRankedSummary(title: string, candidate: RankedSummaryCandidate): string {
  return [
    title,
    "",
    candidate.candidate.text,
    "",
    `Classifier score: ${formatPercentage(candidate.classifierScore)}`,
    `Importance: ${formatPercentage(candidate.evaluation.importance.score)} (confidence ${formatPercentage(candidate.evaluation.importance.confidence)})`,
    `Coverage: ${formatPercentage(candidate.evaluation.coverage.score)} (confidence ${formatPercentage(candidate.evaluation.coverage.confidence)})`,
    `Coherence: ${formatPercentage(candidate.evaluation.coherence.score)} (confidence ${formatPercentage(candidate.evaluation.coherence.confidence)})`,
  ].join("\n");
}

function formatSummaryRanking(
  bestCandidate: RankedSummaryCandidate,
  worstCandidate: RankedSummaryCandidate,
  generatedCandidateCount: number,
  scoredCandidateCount: number,
): string {
  return [
    formatRankedSummary("Best summary", bestCandidate),
    "",
    formatRankedSummary("Worst summary", worstCandidate),
    "",
    `Model: ${bestCandidate.evaluation.model}`,
    `Candidates: ${scoredCandidateCount} scored from ${generatedCandidateCount} generated`,
  ].join("\n");
}

/** Runs the summary candidate CLI against a file or piped article text. */
export async function runSummaryCandidatesCli(args: readonly string[] = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(CLI_USAGE);
    return;
  }
  const unsupportedOption = args.find(
    (argument) => argument.startsWith("-") && argument !== "-" && argument !== "--raw",
  );
  if (unsupportedOption) {
    throw new Error(`Summary candidates CLI: unknown option ${unsupportedOption}`);
  }
  const rawOutput = args.includes("--raw");
  const articlePaths = args.filter((argument) => argument !== "--raw");
  if (articlePaths.length > 1) {
    throw new Error("Summary candidates CLI: expected one article file path");
  }

  const apiKey = process.env["TYPESAFE_JEV_API_KEY"];
  if (!apiKey) {
    throw new Error("Summary candidates CLI: TYPESAFE_JEV_API_KEY is not set");
  }

  const article = await readArticle(articlePaths[0]);
  if (article.trim().length === 0) {
    throw new Error("Summary candidates CLI: article text is empty");
  }

  const generatedCandidates = generateCandidates(article, CANDIDATE_GENERATION_OPTIONS);
  if (generatedCandidates.length === 0) {
    throw new Error("Summary candidates CLI: no summary candidates were generated");
  }
  const candidatesToScore = uniqueCandidateTexts(generatedCandidates);
  const client = new TypeSafeClient({ apiKey, timeout: 30_000 });
  const ranking = await rankSummaryCandidates(
    article,
    candidatesToScore,
    createTypeSafeSummaryCandidateEvaluator(client),
  );
  if (rawOutput) {
    const rawJson = JSON.stringify(ranking.rawResponse, null, 2);
    if (rawJson === undefined) {
      throw new Error("Summary candidates CLI: TypeSafe response could not be serialized as JSON");
    }
    console.log(rawJson);
    return;
  }

  console.log(
    formatSummaryRanking(
      ranking.rankedCandidates[0],
      ranking.rankedCandidates.at(-1)!,
      generatedCandidates.length,
      candidatesToScore.length,
    ),
  );
}
