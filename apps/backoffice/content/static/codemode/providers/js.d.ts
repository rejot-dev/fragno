// js tools
type JsCodemodeProvider = {
  /** Type check a standalone JavaScript file under /static or /workspace against static declarations. */
  check(input: JsCheckInput): Promise<JsCheckOutput>;
  /** Run top-level statements in a saved .js source file or a built .json module under /static or /workspace. Ignores exports; built modules run without compilation and startup errors are returned. */
  run(input: JsRunInput): Promise<JsRunOutput>;
  /** List codemode runs in the current scope, newest first, with their status and what they ran. Lists only runs readable with js.runs.get, so a page can hold fewer runs than its limit (1-20; defaults to 20). Runs are kept for 7 days. */
  runsList(input: JsRunsListInput): Promise<JsRunsListOutput>;
  /** Show one codemode run in the current scope: its outcome, console logs, and every tool call it made with summaries of their input and output, recorded as they happen. Readable only with at least the authority the run had: same principal, no extra delegation, no narrower scope restriction. Runs are kept for 7 days. */
  runsGet(input: JsRunsGetInput): Promise<JsRunsGetOutput>;
  /** Compile a saved JavaScript ES module into a reusable built JSON module under /workspace without executing or activating it. Consumers validate exports. */
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
type JsRunsListInput = {
  limit?: number;
  cursor?: string;
};
type JsRunsListOutput = {
  runs: {
    runId: string;
    activation:
      | {
          kind: "immediate" | "module" | "module-build" | "compiled";
        }
      | {
          kind: "workflow";
          workflowInstanceId: string;
        };
    origin:
      | {
          kind: "inline";
        }
      | {
          kind: "file";
          path: string;
        };
    startedAt: string;
    status: "running" | "completed" | "failed" | "suspended";
  }[];
  nextCursor: string | null;
};
type JsRunsGetInput = {
  runId: string;
};
type JsRunsGetOutput =
  | {
      runId: string;
      activation:
        | {
            kind: "immediate" | "module" | "module-build" | "compiled";
          }
        | {
            kind: "workflow";
            workflowInstanceId: string;
          };
      origin:
        | {
            kind: "inline";
          }
        | {
            kind: "file";
            path: string;
          };
      startedAt: string;
      toolCalls: (
        | {
            scope:
              | {
                  kind: "current";
                }
              | {
                  kind: "org";
                  orgId: string;
                }
              | {
                  kind: "user";
                  userId: string;
                }
              | {
                  kind: "project";
                  projectId: string;
                };
            provider: string;
            tool: string;
            input: string;
            calledAt: string;
            status: "running";
          }
        | {
            scope:
              | {
                  kind: "current";
                }
              | {
                  kind: "org";
                  orgId: string;
                }
              | {
                  kind: "user";
                  userId: string;
                }
              | {
                  kind: "project";
                  projectId: string;
                };
            provider: string;
            tool: string;
            input: string;
            calledAt: string;
            status: "succeeded" | "failed";
            output: string;
            settledAt: string;
          }
      )[];
      toolCallsTruncated: boolean;
      status: "running";
    }
  | {
      runId: string;
      activation:
        | {
            kind: "immediate" | "module" | "module-build" | "compiled";
          }
        | {
            kind: "workflow";
            workflowInstanceId: string;
          };
      origin:
        | {
            kind: "inline";
          }
        | {
            kind: "file";
            path: string;
          };
      startedAt: string;
      toolCalls: (
        | {
            scope:
              | {
                  kind: "current";
                }
              | {
                  kind: "org";
                  orgId: string;
                }
              | {
                  kind: "user";
                  userId: string;
                }
              | {
                  kind: "project";
                  projectId: string;
                };
            provider: string;
            tool: string;
            input: string;
            calledAt: string;
            status: "running";
          }
        | {
            scope:
              | {
                  kind: "current";
                }
              | {
                  kind: "org";
                  orgId: string;
                }
              | {
                  kind: "user";
                  userId: string;
                }
              | {
                  kind: "project";
                  projectId: string;
                };
            provider: string;
            tool: string;
            input: string;
            calledAt: string;
            status: "succeeded" | "failed";
            output: string;
            settledAt: string;
          }
      )[];
      toolCallsTruncated: boolean;
      status: "completed";
      logs: {
        at: number;
        channel: "log" | "info" | "debug" | "warn" | "error" | "codemode";
        text: string;
      }[];
    }
  | {
      runId: string;
      activation:
        | {
            kind: "immediate" | "module" | "module-build" | "compiled";
          }
        | {
            kind: "workflow";
            workflowInstanceId: string;
          };
      origin:
        | {
            kind: "inline";
          }
        | {
            kind: "file";
            path: string;
          };
      startedAt: string;
      toolCalls: (
        | {
            scope:
              | {
                  kind: "current";
                }
              | {
                  kind: "org";
                  orgId: string;
                }
              | {
                  kind: "user";
                  userId: string;
                }
              | {
                  kind: "project";
                  projectId: string;
                };
            provider: string;
            tool: string;
            input: string;
            calledAt: string;
            status: "running";
          }
        | {
            scope:
              | {
                  kind: "current";
                }
              | {
                  kind: "org";
                  orgId: string;
                }
              | {
                  kind: "user";
                  userId: string;
                }
              | {
                  kind: "project";
                  projectId: string;
                };
            provider: string;
            tool: string;
            input: string;
            calledAt: string;
            status: "succeeded" | "failed";
            output: string;
            settledAt: string;
          }
      )[];
      toolCallsTruncated: boolean;
      status: "failed";
      logs: {
        at: number;
        channel: "log" | "info" | "debug" | "warn" | "error" | "codemode";
        text: string;
      }[];
      error: string;
    }
  | {
      runId: string;
      activation:
        | {
            kind: "immediate" | "module" | "module-build" | "compiled";
          }
        | {
            kind: "workflow";
            workflowInstanceId: string;
          };
      origin:
        | {
            kind: "inline";
          }
        | {
            kind: "file";
            path: string;
          };
      startedAt: string;
      toolCalls: (
        | {
            scope:
              | {
                  kind: "current";
                }
              | {
                  kind: "org";
                  orgId: string;
                }
              | {
                  kind: "user";
                  userId: string;
                }
              | {
                  kind: "project";
                  projectId: string;
                };
            provider: string;
            tool: string;
            input: string;
            calledAt: string;
            status: "running";
          }
        | {
            scope:
              | {
                  kind: "current";
                }
              | {
                  kind: "org";
                  orgId: string;
                }
              | {
                  kind: "user";
                  userId: string;
                }
              | {
                  kind: "project";
                  projectId: string;
                };
            provider: string;
            tool: string;
            input: string;
            calledAt: string;
            status: "succeeded" | "failed";
            output: string;
            settledAt: string;
          }
      )[];
      toolCallsTruncated: boolean;
      status: "suspended";
      logs: {
        at: number;
        channel: "log" | "info" | "debug" | "warn" | "error" | "codemode";
        text: string;
      }[];
    };
type JsBuildInput = {
  path: string;
  out: string;
};
type JsBuildOutput =
  | {
      status: "success";
      path: string;
      outputPath: string;
      runId: string;
      warnings: string[];
    }
  | {
      status: "error";
      path: string;
      outputPath: string;
      runId: string;
      error: string;
    }
  | {
      status: "rejected";
      path: string;
      outputPath: string;
      error: string;
    };
