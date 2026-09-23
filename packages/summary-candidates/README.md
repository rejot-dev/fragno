# `@fragno-dev/summary-candidates`

Generate deterministic, CPU-only extractive summary candidates for a separate classifier to score.
The package uses an English winkNLP model for sentence segmentation, token normalization, stop-word
removal, and stemming.

```ts
import { generateCandidates } from "@fragno-dev/summary-candidates";

const candidates = generateCandidates(article, {
  maxInputSentences: 100,
  candidates: 30,
  summarySentences: [3, 4, 5],
});
```

## Select the best candidate with TypeSafe

Set the API key and pass an article file:

```sh
export TYPESAFE_JEV_API_KEY="..."
summary-candidates article.txt
```

Article text can also be piped through standard input:

```sh
cat article.txt | summary-candidates
```

Pass `--raw` to print only the unprocessed JSON response returned by TypeSafe:

```sh
summary-candidates --raw article.txt
```

Five source-grounded sample articles of roughly 500–550 words are included for trying the CLI:

```sh
summary-candidates samples/nasa-webb-exoplanet-atmosphere.txt
summary-candidates samples/nps-klamath-river-restoration.txt
summary-candidates samples/doe-solar-futures-study.txt
summary-candidates samples/usda-farm-to-school-census.txt
summary-candidates samples/loc-digital-folklife-collections.txt
```

See `samples/README.md` for the official NASA, National Park Service, Department of Energy,
Department of Agriculture, and Library of Congress sources.

The CLI generates up to 20 four-sentence candidates, removes duplicate candidate text, and sends the
article plus all remaining candidates to TypeSafe Jev in one API request. Jev scores every candidate
for importance, coverage, and coherence. The CLI prints the highest and lowest weighted results
together with their normalized dimension scores and confidence values.

## `generateCandidates(text, options)`

The function returns as many unique candidates as it can produce, up to `options.candidates`. Short
documents or restrictive summary lengths can have fewer unique sentence subsets.

Candidate selection is deterministic. Sentences are represented with TF-IDF, long documents are
prefiltered to `maxInputSentences`, and maximal marginal relevance generates varied subsets. Output
sentences are restored to document order.

`maxInputSentences` must be between 1 and 100. `candidates` and every value in `summarySentences`
must be positive integers.

```ts
type GenerateCandidatesOptions = {
  maxInputSentences: number;
  candidates: number;
  summarySentences: readonly number[];
};

type CandidateSummary = {
  // Zero-based IDs from the original document, sorted in document order.
  sentenceIds: number[];
  text: string;
  // A generation heuristic, not a classifier score. Higher is better.
  generationScore: number;
};
```
