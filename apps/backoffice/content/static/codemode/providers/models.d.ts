// models tools
type ModelsCodemodeProvider = {
  /** Answer typed questions about JSON state with a fast classifier model. A `choice` question picks one option with probabilities, a `score` question rates against ordered levels, and a `bool` question returns the probability that a condition holds. Use it for routing, triage, and filtering; it does not generate text. Independent questions about the same state belong in one call. Each call is billed by input tokens. */
  classify(input: ModelsClassifyInput): Promise<ModelsClassifyOutput>;
};
declare const models: ModelsCodemodeProvider;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };
type ModelsClassifyInput = {
  /** The evidence every question is answered about. */
  state: {
    [key: string]: JsonValue;
  };
  questions: {
    [key: string]:
      | {
          type: "choice";
          instructions: string;
          /** Each option's value mapped to when it applies. */
          criteria: {
            [key: string]: string;
          };
        }
      | {
          type: "score";
          instructions: string;
          /** Ordered levels from lowest to highest; the score is a 0-based level index. */
          criteria: string[];
        }
      | {
          type: "bool";
          instructions: string;
          criteria: {
            true: string;
            false: string;
          };
        };
  };
};
type ModelsClassifyOutput = {
  /** One answer per question, keyed by question name. */
  answers: {
    [key: string]:
      | {
          type: "choice";
          choice: string;
          probabilities: {
            [key: string]: number;
          };
          confidence: number;
        }
      | {
          type: "score";
          /** Probability-weighted level index; may fall between levels. */
          score: number;
          confidence: number;
        }
      | {
          type: "bool";
          /** Probability that the condition is true. */
          probability: number;
        };
  };
};
