// js tools
type JsCodemodeProvider = {
  /** Type check a standalone JavaScript file under /static or /workspace against static declarations. */
  check(input: JsCheckInput): Promise<JsCheckOutput>;
  /** Run top-level statements in a saved .js source file or a built .json module artifact under /static or /workspace. Ignores exports; artifacts run without compilation and startup errors are returned. */
  run(input: JsRunInput): Promise<JsRunOutput>;
  /** Compile a saved JavaScript ES module into a reusable JSON artifact under /workspace without executing or activating it. Consumers validate exports. */
  build(input: JsBuildInput): Promise<JsBuildOutput>;
};
declare const js: JsCodemodeProvider;

type JsCheckInput = {
  path: string;
};
type JsCheckOutput = {
  path: string;
  valid: boolean;
  diagnostics: {
    code: number;
    path: string | null;
    line: number | null;
    column: number | null;
    message: string;
  }[];
};
type JsRunInput = {
  path: string;
};
type JsRunOutput =
  | {
      status: "success";
      path: string;
      logs: string[];
    }
  | {
      status: "error";
      path: string;
      error: string;
      logs: string[];
    };
type JsBuildInput = {
  path: string;
  out: string;
};
type JsBuildOutput =
  | {
      status: "success";
      path: string;
      artifactPath: string;
      warnings: string[];
    }
  | {
      status: "error";
      path: string;
      artifactPath: string;
      error: string;
    };
