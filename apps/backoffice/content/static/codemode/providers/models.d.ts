// models tools
type ModelsCodemodeProvider = {
  /** Answer typed questions about JSON state and workspace images with a fast classifier model. A `choice` question picks one option with probabilities, a `score` question rates against ordered levels, and a `bool` question returns the probability that a condition holds. Use it for routing, triage, and filtering; it does not generate text. Independent questions about the same state and images belong in one call. Image paths require upload.read; text-only calls do not. Each call is billed by input tokens, including image tokens. */
  classify(input: ModelsClassifyInput): Promise<ModelsClassifyOutput>;
  /** Generate an image from a prompt and write it to the workspace. Generation can take up to two minutes, longer than an immediate codemode run is allowed, so call it inside a workflow step. Each call is billed by input and output tokens, which grow with size and quality. */
  generateImage(input: ModelsGenerateImageInput): Promise<ModelsGenerateImageOutput>;
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
  /** Ordered workspace image paths judged together with state; requires upload.read for each file. Up to 128 PNG, JPEG, or WebP images; at most 10 MiB per image and 20 MiB total. */
  images?: string[];
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
type ModelsGenerateImageInput = {
  /** What the image shows and how. */
  prompt: string;
  /** Absolute path of the image to write under /workspace. Its extension picks the format. */
  out: string;
  /** Square, landscape, or portrait; `auto` lets the model choose from the prompt. */
  size?: "auto" | "1024x1024" | "1536x1024" | "1024x1536";
  /** Higher quality takes longer and costs more; `low` suits drafts. */
  quality?: "auto" | "low" | "medium" | "high" | "xhigh" | "max";
};
type ModelsGenerateImageOutput = {
  /** Where the image was written. */
  path: string;
};
