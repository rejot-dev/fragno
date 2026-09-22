// js tools
type JsCodemodeProvider = {
  /** Type check a standalone JavaScript file under /static or /workspace against static declarations. */
  check(input: JsCheckInput): Promise<JsCheckOutput>;
  /** Run a standalone saved JavaScript file as an ES module under /static or /workspace. */
  run(input: JsRunInput): Promise<JsRunOutput>;
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
