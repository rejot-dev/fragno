// Classifiers for typed questions about data and images, typed extraction from PDFs and images, and image generation. Read to classify, read a PDF, or generate images.
type ModelsCodemodeProvider = {
  /**
   * Answer typed questions about JSON state and images with a fast classifier model. A `choice` question picks one option with probabilities, a `score` question rates against ordered levels, and a `bool` question returns the probability that a condition holds. Use it for routing, triage, and filtering; it does not generate text. Independent questions about the same state and images belong in one call. Images require upload.read; text-only calls do not. Each call is billed by input tokens, including image tokens.
   * Requires `models.classify`.
   */
  classify(input: ModelsClassifyInput): Promise<ModelsClassifyOutput>;
  /**
   * Generate an image from a prompt and write it to the workspace. Generation can take up to two minutes, longer than an immediate codemode run is allowed, so call it inside a workflow step. Each call is billed by input and output tokens, which grow with size and quality.
   * Requires `models.generateImage` and `upload.modify`.
   */
  generateImage(input: ModelsGenerateImageInput): Promise<ModelsGenerateImageOutput>;
  /**
   * Read PDFs and images from the workspace or blobs with a model and answer in JSON that matches a schema: invoice fields, a contract's parties, a statement's transactions, or a page as Markdown. The files go to the model, not into the conversation, so only the answer costs context. A long document can take longer than an immediate codemode run is allowed, so call it inside a workflow step. Each call is billed by input and output tokens, including every page and image.
   * Requires `models.extract`.
   */
  extract(input: ModelsExtractInput): Promise<ModelsExtractOutput>;
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
  /** Ordered images judged together with state, each a workspace file `{ path }` or a blob `{ blob }` by key; requires upload.read for each. Blobs hold images too large for the workspace. Up to 128 PNG, JPEG, or WebP images; at most 10 MiB per image and 20 MiB total. */
  images?: (
    | {
        path: string;
      }
    | {
        /** The blob's name within the scope, e.g. recordings/2026-10-26.mp4. Slash-separated segments, none empty, '.' or '..'. */
        blob: string;
      }
  )[];
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
type ModelsExtractInput = {
  /** Ordered PDFs and PNG, JPEG, or WebP images to read, each a workspace file `{ path }` or a blob `{ blob }` by key; requires upload.read for each. Blobs hold documents too large for the workspace. Up to 16 files and 20 MiB together. */
  files: (
    | {
        path: string;
      }
    | {
        /** The blob's name within the scope, e.g. recordings/2026-10-26.mp4. Slash-separated segments, none empty, '.' or '..'. */
        blob: string;
      }
  )[];
  /** What to read from the files and how to fill in the answer. */
  instructions: string;
  /** JSON Schema of the answer, in OpenAI's strict structured-output subset: the root is an object, every object is closed and requires all its properties, which the call sets itself, and a field that may be absent has a type such as `["string", "null"]`. */
  schema: {
    [key: string]: JsonValue;
  };
  /** The model that reads the files. gpt-6.1-sol is the stronger model; it costs about 20 times as much per token as gpt-6-luna and takes longer. */
  model?: "openai/gpt-6-luna" | "openai/gpt-6.1-sol";
  /** How much the model reasons before it answers; more costs more and takes longer. */
  thinkingLevel?: "low" | "medium" | "high";
};
type ModelsExtractOutput = {
  output: JsonValue;
};
