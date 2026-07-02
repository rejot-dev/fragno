import {
  err,
  ExecutionError,
  FileError,
  ok,
  type ExecutionEnv,
  type ExecutionEnvExecOptions,
  type FileInfo,
  type Result,
} from "@earendil-works/pi-agent-core";

export type NoOpExecutionEnvOptions = {
  cwd?: string;
};

const normalizeSeparators = (path: string): string => path.replace(/\\+/g, "/");

const normalizeAbsolutePath = (path: string): string => {
  const normalized = normalizeSeparators(path);
  const parts: string[] = [];

  for (const part of normalized.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  return `/${parts.join("/")}`;
};

const aborted = (signal?: AbortSignal): Result<never, FileError> | undefined => {
  if (!signal?.aborted) {
    return undefined;
  }
  return err(new FileError("aborted", "File operation aborted"));
};

const unsupported = <TValue>(operation: string, path?: string): Result<TValue, FileError> =>
  err(
    new FileError(
      "not_supported",
      `${operation} is not supported by this execution environment`,
      path,
    ),
  );

export class NoOpExecutionEnv implements ExecutionEnv {
  readonly cwd: string;

  constructor(options: NoOpExecutionEnvOptions = {}) {
    this.cwd = normalizeAbsolutePath(options.cwd ?? "/workspace");
  }

  async absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const abortedResult = aborted(abortSignal);
    if (abortedResult) {
      return abortedResult;
    }

    return ok(this.resolvePath(path));
  }

  async joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const abortedResult = aborted(abortSignal);
    if (abortedResult) {
      return abortedResult;
    }

    return ok(this.resolvePath(parts.join("/")));
  }

  async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const abortedResult = aborted(abortSignal);
    if (abortedResult) {
      return abortedResult;
    }

    return unsupported("Text file reads", this.resolvePath(path));
  }

  async readTextLines(
    path: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ): Promise<Result<string[], FileError>> {
    const abortedResult = aborted(options?.abortSignal);
    if (abortedResult) {
      return abortedResult;
    }

    return unsupported("Text line reads", this.resolvePath(path));
  }

  async readBinaryFile(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<Uint8Array, FileError>> {
    const abortedResult = aborted(abortSignal);
    if (abortedResult) {
      return abortedResult;
    }

    return unsupported("Binary file reads", this.resolvePath(path));
  }

  async writeFile(
    path: string,
    _content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const abortedResult = aborted(abortSignal);
    if (abortedResult) {
      return abortedResult;
    }

    return unsupported("File writes", this.resolvePath(path));
  }

  async appendFile(
    path: string,
    _content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const abortedResult = aborted(abortSignal);
    if (abortedResult) {
      return abortedResult;
    }

    return unsupported("File appends", this.resolvePath(path));
  }

  async fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
    const abortedResult = aborted(abortSignal);
    if (abortedResult) {
      return abortedResult;
    }

    return unsupported("File metadata reads", this.resolvePath(path));
  }

  async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    const abortedResult = aborted(abortSignal);
    if (abortedResult) {
      return abortedResult;
    }

    return unsupported("Directory listing", this.resolvePath(path));
  }

  async canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const abortedResult = aborted(abortSignal);
    if (abortedResult) {
      return abortedResult;
    }

    return unsupported("Canonical path resolution", this.resolvePath(path));
  }

  async exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
    const abortedResult = aborted(abortSignal);
    if (abortedResult) {
      return abortedResult;
    }

    return unsupported("File existence checks", this.resolvePath(path));
  }

  async createDir(
    path: string,
    options?: { recursive?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>> {
    const abortedResult = aborted(options?.abortSignal);
    if (abortedResult) {
      return abortedResult;
    }

    return unsupported("Directory creation", this.resolvePath(path));
  }

  async remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>> {
    const abortedResult = aborted(options?.abortSignal);
    if (abortedResult) {
      return abortedResult;
    }

    return unsupported("File removal", this.resolvePath(path));
  }

  async createTempDir(
    prefix = "tmp-",
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>> {
    const abortedResult = aborted(abortSignal);
    if (abortedResult) {
      return abortedResult;
    }

    return unsupported("Temporary directory creation", this.resolvePath(prefix));
  }

  async createTempFile(options?: {
    prefix?: string;
    suffix?: string;
    abortSignal?: AbortSignal;
  }): Promise<Result<string, FileError>> {
    const abortedResult = aborted(options?.abortSignal);
    if (abortedResult) {
      return abortedResult;
    }

    return unsupported("Temporary file creation", this.resolvePath(options?.prefix ?? "tmp"));
  }

  async exec(
    _command: string,
    _options?: ExecutionEnvExecOptions,
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    return err(
      new ExecutionError(
        "shell_unavailable",
        "Shell execution is not available in this environment",
      ),
    );
  }

  async cleanup(): Promise<void> {
    // Nothing to release.
  }

  private resolvePath(path: string): string {
    const normalized = normalizeSeparators(path);
    return normalizeAbsolutePath(
      normalized.startsWith("/") ? normalized : `${this.cwd}/${normalized}`,
    );
  }
}
