// js tools
type JsCodemodeProvider = {
  /** Type check a standalone JavaScript file under /static or /workspace against static declarations. */
  check(input: JsCheckInput): Promise<JsCheckOutput>;
  /** Run top-level statements in a saved .js source file or a built .json module artifact under /static or /workspace. Ignores exports; artifacts run without compilation and startup errors are returned. */
  run(input: JsRunInput): Promise<JsRunOutput>;
  /** Show the console logs and outcome of a codemode run in the current scope, by run ID. Readable only with at least the authority the run had: same principal, no extra delegation, no narrower scope restriction. Codemode run events carry run IDs; runs are kept for 7 days. */
  logs(input: JsLogsInput): Promise<JsLogsOutput>;
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
      runId: string;
      logs: {
        at: number;
        channel: "log" | "info" | "debug" | "warn" | "error" | "codemode";
        text: string;
      }[];
    }
  | {
      status: "error";
      path: string;
      runId: string;
      error: string;
      logs: {
        at: number;
        channel: "log" | "info" | "debug" | "warn" | "error" | "codemode";
        text: string;
      }[];
    }
  | {
      status: "rejected";
      path: string;
      error: string;
    };
type JsLogsInput = {
  runId: string;
};
type JsLogsOutput =
  | {
      runId: string;
      status: "running";
    }
  | {
      runId: string;
      status: "completed";
      logs: {
        at: number;
        channel: "log" | "info" | "debug" | "warn" | "error" | "codemode";
        text: string;
      }[];
    }
  | {
      runId: string;
      status: "failed";
      logs: {
        at: number;
        channel: "log" | "info" | "debug" | "warn" | "error" | "codemode";
        text: string;
      }[];
      error: string;
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
      runId: string;
      warnings: string[];
    }
  | {
      status: "error";
      path: string;
      artifactPath: string;
      runId: string;
      error: string;
    }
  | {
      status: "rejected";
      path: string;
      artifactPath: string;
      error: string;
    };
