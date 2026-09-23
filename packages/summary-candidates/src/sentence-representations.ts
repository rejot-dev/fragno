import englishModel from "wink-eng-lite-web-model";
import winkNLP from "wink-nlp";
import type { ItemToken, ItsFunction } from "wink-nlp";

const englishNlp = winkNLP(englishModel);

type RawSentence = {
  id: number;
  text: string;
  termFrequencies: Map<string, number>;
  termCount: number;
};

/** A sentence represented by sparse TF-IDF features and document-level relevance signals. */
export type SummarySentenceRepresentation = {
  id: number;
  text: string;
  vector: Map<string, number>;
  vectorMagnitude: number;
  relevance: number;
};

/** The prefiltered sentence pool and its pairwise cosine similarities. */
export type SummarySentencePool = {
  sentences: SummarySentenceRepresentation[];
  similarities: number[][];
};

/* oxlint-disable typescript/unbound-method -- winkNLP's out API requires its helpers by reference. */
function parseEnglishSentences(text: string): RawSentence[] {
  const document = englishNlp.readDoc(text);
  const sentences: RawSentence[] = [];

  document.sentences().each((sentence, sentenceIndex) => {
    const termFrequencies = new Map<string, number>();
    let termCount = 0;

    sentence.tokens().each((token: ItemToken) => {
      const tokenType = token.out(englishNlp.its.type);
      if (tokenType !== "word" && tokenType !== "number") {
        return;
      }
      if (token.out(englishNlp.its.stopWordFlag) === true) {
        return;
      }

      const normalizedTerm = token
        .out(
          (tokenType === "word"
            ? englishNlp.its.stem
            : englishNlp.its.normal) as ItsFunction<string>,
        )
        .toLocaleLowerCase("en-US");
      if (normalizedTerm.length === 0) {
        return;
      }

      termFrequencies.set(normalizedTerm, (termFrequencies.get(normalizedTerm) ?? 0) + 1);
      termCount += 1;
    });

    sentences.push({
      id: sentenceIndex,
      text: sentence.out(),
      termFrequencies,
      termCount,
    });
  });

  return sentences;
}
/* oxlint-enable typescript/unbound-method */

function calculateInverseDocumentFrequencies(sentences: RawSentence[]): Map<string, number> {
  const documentFrequencies = new Map<string, number>();

  for (const sentence of sentences) {
    for (const term of sentence.termFrequencies.keys()) {
      documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
    }
  }

  return new Map(
    [...documentFrequencies].map(([term, documentFrequency]) => [
      term,
      Math.log((sentences.length + 1) / (documentFrequency + 1)) + 1,
    ]),
  );
}

function calculateVectorMagnitude(vector: Map<string, number>): number {
  let squaredMagnitude = 0;
  for (const weight of vector.values()) {
    squaredMagnitude += weight * weight;
  }
  return Math.sqrt(squaredMagnitude);
}

function cosineSimilarity(
  leftVector: Map<string, number>,
  leftMagnitude: number,
  rightVector: Map<string, number>,
  rightMagnitude: number,
): number {
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  const [smallerVector, largerVector] =
    leftVector.size <= rightVector.size ? [leftVector, rightVector] : [rightVector, leftVector];
  let dotProduct = 0;
  for (const [term, weight] of smallerVector) {
    dotProduct += weight * (largerVector.get(term) ?? 0);
  }

  return dotProduct / (leftMagnitude * rightMagnitude);
}

function normalizeScores(scores: number[]): number[] {
  if (scores.length === 0) {
    return [];
  }

  const minimum = Math.min(...scores);
  const maximum = Math.max(...scores);
  if (minimum === maximum) {
    return scores.map((score) => (score === 0 ? 0 : 1));
  }

  return scores.map((score) => (score - minimum) / (maximum - minimum));
}

function representEnglishSentences(sentences: RawSentence[]): SummarySentenceRepresentation[] {
  const inverseDocumentFrequencies = calculateInverseDocumentFrequencies(sentences);
  const representedSentences = sentences.map((sentence) => {
    const vector = new Map<string, number>();
    let totalTfidfWeight = 0;

    for (const [term, frequency] of sentence.termFrequencies) {
      const inverseDocumentFrequency = inverseDocumentFrequencies.get(term) ?? 0;
      const weight = (1 + Math.log(frequency)) * inverseDocumentFrequency;
      vector.set(term, weight);
      totalTfidfWeight += weight;
    }

    return {
      sentence,
      vector,
      vectorMagnitude: calculateVectorMagnitude(vector),
      tfidfImportance: sentence.termCount === 0 ? 0 : totalTfidfWeight / sentence.termCount,
    };
  });

  const centroid = new Map<string, number>();
  for (const representedSentence of representedSentences) {
    if (representedSentence.vectorMagnitude === 0) {
      continue;
    }
    for (const [term, weight] of representedSentence.vector) {
      centroid.set(
        term,
        (centroid.get(term) ?? 0) +
          weight / representedSentence.vectorMagnitude / representedSentences.length,
      );
    }
  }
  const centroidMagnitude = calculateVectorMagnitude(centroid);
  const normalizedImportance = normalizeScores(
    representedSentences.map((sentence) => sentence.tfidfImportance),
  );

  return representedSentences.map((representedSentence, sentenceIndex) => {
    const positionPrior =
      representedSentences.length === 1 ? 1 : 1 - sentenceIndex / (representedSentences.length - 1);
    const centroidSimilarity = cosineSimilarity(
      representedSentence.vector,
      representedSentence.vectorMagnitude,
      centroid,
      centroidMagnitude,
    );

    return {
      id: representedSentence.sentence.id,
      text: representedSentence.sentence.text,
      vector: representedSentence.vector,
      vectorMagnitude: representedSentence.vectorMagnitude,
      relevance:
        0.72 * centroidSimilarity +
        0.2 * normalizedImportance[sentenceIndex] +
        0.08 * positionPrior,
    };
  });
}

function prefilterSentenceRepresentations(
  sentences: SummarySentenceRepresentation[],
  maxInputSentences: number,
): SummarySentenceRepresentation[] {
  if (sentences.length <= maxInputSentences) {
    return sentences;
  }

  return sentences
    .toSorted((left, right) => right.relevance - left.relevance || left.id - right.id)
    .slice(0, maxInputSentences)
    .toSorted((left, right) => left.id - right.id);
}

function calculateSentenceSimilarities(sentences: SummarySentenceRepresentation[]): number[][] {
  const similarities = sentences.map(() => sentences.map(() => 0));

  for (let leftIndex = 0; leftIndex < sentences.length; leftIndex += 1) {
    similarities[leftIndex][leftIndex] = 1;
    for (let rightIndex = leftIndex + 1; rightIndex < sentences.length; rightIndex += 1) {
      const leftSentence = sentences[leftIndex];
      const rightSentence = sentences[rightIndex];
      const similarity = cosineSimilarity(
        leftSentence.vector,
        leftSentence.vectorMagnitude,
        rightSentence.vector,
        rightSentence.vectorMagnitude,
      );
      similarities[leftIndex][rightIndex] = similarity;
      similarities[rightIndex][leftIndex] = similarity;
    }
  }

  return similarities;
}

/** Parses English text, computes TF-IDF features, and limits MMR input to the requested pool size. */
export function buildSummarySentencePool(
  text: string,
  maxInputSentences: number,
): SummarySentencePool {
  const sentences = prefilterSentenceRepresentations(
    representEnglishSentences(parseEnglishSentences(text)),
    maxInputSentences,
  );

  return {
    sentences,
    similarities: calculateSentenceSimilarities(sentences),
  };
}
