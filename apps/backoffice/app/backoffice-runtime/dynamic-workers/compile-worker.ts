import type { WorkerBundle } from "./worker-bundle";

export type CompileWorkerInput = {
  files: Readonly<Record<string, string>>;
  entryPoint: string;
  dependencies: Readonly<Record<string, string>>;
  runtime: {
    compatibilityDate: string;
    compatibilityFlags: readonly string[];
  };
};

export type CompiledWorker = {
  bundle: WorkerBundle;
  warnings: string[];
};

/** Lazily reads one project file when the compiler request stream needs it. */
export type TypeCheckFileSource = {
  path: string;
  read: () => Promise<string>;
};

export type TypeCheckFilesInput = {
  files: readonly TypeCheckFileSource[];
  sourcePaths: readonly string[];
};

/** Complete project stream consumed once inside the compiler Worker. */
export type TypeCheckProjectInput = {
  files: AsyncIterable<readonly [path: string, content: string]>;
  sourcePaths: readonly string[];
};

export type TypeCheckDiagnostic = {
  code: number;
  path: string | null;
  line: number | null;
  column: number | null;
  message: string;
};

export type TypeCheckFilesResult = {
  diagnostics: TypeCheckDiagnostic[];
};

export type WorkerCompilationErrorCode =
  | "INVALID_INPUT"
  | "DEPENDENCY_INSTALL_FAILED"
  | "UNSUPPORTED_MODULE"
  | "INTERNAL_ERROR";

/** Failure returned by the stateless codemode compiler service. */
export class WorkerCompilationError extends Error {
  readonly code: WorkerCompilationErrorCode;

  constructor(code: WorkerCompilationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkerCompilationError";
    this.code = code;
  }
}

/** Compiles source files into a Worker bundle without owning where compilation executes. */
export type WorkerCompiler = (input: CompileWorkerInput) => Promise<CompiledWorker>;

/** Type checks JavaScript source by streaming an explicit project into the compiler Worker. */
export type WorkerTypeChecker = (input: TypeCheckFilesInput) => Promise<TypeCheckFilesResult>;

/** Private streaming RPC API implemented by the independently deployed compiler Worker. */
export type WorkerCompilerService = {
  compileWorker(request: Request): Promise<Response>;
  typeCheckFiles(request: Request): Promise<Response>;
};
