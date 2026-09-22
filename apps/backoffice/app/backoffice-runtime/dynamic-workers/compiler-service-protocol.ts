import {
  WorkerCompilationError,
  type CompiledWorker,
  type CompileWorkerInput,
  type TypeCheckDiagnostic,
  type TypeCheckFilesInput,
  type TypeCheckFilesResult,
  type TypeCheckProjectInput,
} from "./compile-worker";
import { createWorkerBundle } from "./worker-bundle";

const COMPILER_ARCHIVE_CONTENT_TYPE = "application/vnd.fragno.compiler-archive";
const COMPILER_ARCHIVE_MAGIC = new Uint8Array([0x46, 0x43, 0x50, 0x31]);
const MAX_COMPILER_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_COMPILER_ARCHIVE_FILES = 20_000;
const MAX_COMPILER_FILE_PATH_BYTES = 4 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

type CompileWorkerRequestManifest = {
  protocolVersion: 1;
  operation: "compile-worker";
  entryPoint: string;
  dependencies: Readonly<Record<string, string>>;
  runtime: {
    compatibilityDate: string;
    compatibilityFlags: readonly string[];
  };
};

type TypeCheckFilesRequestManifest = {
  protocolVersion: 1;
  operation: "type-check-files";
  sourcePaths: readonly string[];
};

type CompileWorkerResponseManifest = {
  protocolVersion: 1;
  operation: "compile-worker-result";
  mainModule: string;
  warnings: readonly string[];
  runtime: {
    compatibilityDate: string;
    compatibilityFlags: readonly string[];
  };
};

type CompilerErrorResponse = {
  code: "INVALID_INPUT" | "DEPENDENCY_INSTALL_FAILED" | "UNSUPPORTED_MODULE" | "INTERNAL_ERROR";
  message: string;
};

type CompilerArchiveManifest =
  | CompileWorkerRequestManifest
  | TypeCheckFilesRequestManifest
  | CompileWorkerResponseManifest;

type CompilerArchiveFileEntry = readonly [path: string, content: string];

type CompilerArchiveFileSource = {
  path: string;
  read: () => Promise<string>;
};

type CompilerArchive = {
  manifest: unknown;
  files: AsyncIterable<CompilerArchiveFileEntry>;
  cancel: (reason?: unknown) => Promise<void>;
};

function createUint32Bytes(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function createCompilerArchiveFileSources(
  files: Readonly<Record<string, string>>,
): CompilerArchiveFileSource[] {
  return Object.entries(files).map(([path, content]) => ({
    path,
    read: async () => content,
  }));
}

async function* encodeCompilerArchive(
  manifest: CompilerArchiveManifest,
  files: readonly CompilerArchiveFileSource[],
): AsyncGenerator<Uint8Array> {
  const manifestBytes = textEncoder.encode(JSON.stringify(manifest));
  if (files.length > MAX_COMPILER_ARCHIVE_FILES) {
    throw new WorkerCompilationError(
      "INVALID_INPUT",
      `Compiler archive exceeds the ${MAX_COMPILER_ARCHIVE_FILES} file limit.`,
    );
  }

  let archiveBytes = 12 + manifestBytes.byteLength;
  yield COMPILER_ARCHIVE_MAGIC;
  yield createUint32Bytes(manifestBytes.byteLength);
  yield createUint32Bytes(files.length);
  yield manifestBytes;

  const encodedFiles = await Promise.all(
    files.map(async (file) => {
      validateCompilerArchivePath(file.path);
      const pathBytes = textEncoder.encode(file.path);
      if (pathBytes.byteLength === 0 || pathBytes.byteLength > MAX_COMPILER_FILE_PATH_BYTES) {
        throw new WorkerCompilationError(
          "INVALID_INPUT",
          `Compiler archive path '${file.path}' has an invalid UTF-8 byte length.`,
        );
      }

      return {
        pathBytes,
        contentBytes: textEncoder.encode(await file.read()),
      };
    }),
  );

  for (const { pathBytes, contentBytes } of encodedFiles) {
    archiveBytes += 8 + pathBytes.byteLength + contentBytes.byteLength;
    if (archiveBytes > MAX_COMPILER_ARCHIVE_BYTES) {
      throw new WorkerCompilationError(
        "INVALID_INPUT",
        `Compiler archive exceeds the ${MAX_COMPILER_ARCHIVE_BYTES} byte limit.`,
      );
    }

    yield createUint32Bytes(pathBytes.byteLength);
    yield createUint32Bytes(contentBytes.byteLength);
    yield pathBytes;
    yield contentBytes;
  }
}

function createCompilerArchiveBody(
  manifest: CompilerArchiveManifest,
  files: readonly CompilerArchiveFileSource[],
) {
  const chunks = encodeCompilerArchive(manifest, files);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await chunks.return(reason);
    },
  });
}

function createCompilerServiceRequest(
  path: string,
  manifest: CompileWorkerRequestManifest | TypeCheckFilesRequestManifest,
  files: readonly CompilerArchiveFileSource[],
) {
  return new Request(`https://codemode-compiler.internal${path}`, {
    method: "POST",
    headers: { "content-type": COMPILER_ARCHIVE_CONTENT_TYPE },
    body: createCompilerArchiveBody(manifest, files),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function assertObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkerCompilationError("INVALID_INPUT", `${name} must be an object.`);
  }
}

function parseString(value: unknown, name: string) {
  if (typeof value !== "string") {
    throw new WorkerCompilationError("INVALID_INPUT", `${name} must be a string.`);
  }
  return value;
}

function parseStringArray(value: unknown, name: string) {
  if (!Array.isArray(value)) {
    throw new WorkerCompilationError("INVALID_INPUT", `${name} must be an array of strings.`);
  }
  return value.map((entry) => parseString(entry, `${name} entry`));
}

function parseStringRecord(value: unknown, name: string) {
  assertObject(value, name);
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new WorkerCompilationError("INVALID_INPUT", `${name}.${key} must be a string.`);
    }
  }
  return value as Record<string, string>;
}

function validateCompilerArchivePath(path: string) {
  const pathSegments = path.split("/");
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    pathSegments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new WorkerCompilationError(
      "INVALID_INPUT",
      `Compiler archive path '${path}' must be a normalized relative path.`,
    );
  }
}

class CompilerArchiveReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #chunks: Uint8Array[] = [];
  #firstChunkOffset = 0;
  #availableBytes = 0;
  #totalBytes = 0;
  #complete = false;

  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader();
  }

  async #fill(length: number) {
    while (this.#availableBytes < length && !this.#complete) {
      const next = await this.#reader.read();
      if (next.done) {
        this.#complete = true;
        break;
      }
      this.#totalBytes += next.value.byteLength;
      if (this.#totalBytes > MAX_COMPILER_ARCHIVE_BYTES) {
        throw new WorkerCompilationError(
          "INVALID_INPUT",
          `Compiler archive exceeds the ${MAX_COMPILER_ARCHIVE_BYTES} byte limit.`,
        );
      }
      this.#chunks.push(next.value);
      this.#availableBytes += next.value.byteLength;
    }
  }

  async readBytes(length: number) {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new WorkerCompilationError(
        "INVALID_INPUT",
        "Compiler archive contains an invalid length.",
      );
    }
    await this.#fill(length);
    if (this.#availableBytes < length) {
      throw new WorkerCompilationError("INVALID_INPUT", "Compiler archive ended unexpectedly.");
    }

    const bytes = new Uint8Array(length);
    let writtenBytes = 0;
    while (writtenBytes < length) {
      const chunk = this.#chunks[0];
      const availableChunkBytes = chunk.byteLength - this.#firstChunkOffset;
      const copiedBytes = Math.min(length - writtenBytes, availableChunkBytes);
      bytes.set(
        chunk.subarray(this.#firstChunkOffset, this.#firstChunkOffset + copiedBytes),
        writtenBytes,
      );
      writtenBytes += copiedBytes;
      this.#firstChunkOffset += copiedBytes;
      this.#availableBytes -= copiedBytes;
      if (this.#firstChunkOffset === chunk.byteLength) {
        this.#chunks.shift();
        this.#firstChunkOffset = 0;
      }
    }
    return bytes;
  }

  async readUint32() {
    const bytes = await this.readBytes(4);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  }

  async assertComplete() {
    await this.#fill(this.#availableBytes + 1);
    if (this.#availableBytes > 0) {
      throw new WorkerCompilationError(
        "INVALID_INPUT",
        "Compiler archive contains trailing bytes.",
      );
    }
  }

  async cancel(reason?: unknown) {
    await this.#reader.cancel(reason);
  }
}

async function readCompilerArchive(message: {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}): Promise<CompilerArchive> {
  if (message.headers.get("content-type") !== COMPILER_ARCHIVE_CONTENT_TYPE) {
    throw new WorkerCompilationError(
      "INVALID_INPUT",
      `Compiler request content type must be '${COMPILER_ARCHIVE_CONTENT_TYPE}'.`,
    );
  }
  if (!message.body) {
    throw new WorkerCompilationError("INVALID_INPUT", "Compiler request body is required.");
  }

  const reader = new CompilerArchiveReader(message.body);
  const magic = await reader.readBytes(COMPILER_ARCHIVE_MAGIC.byteLength);
  if (!magic.every((value, index) => value === COMPILER_ARCHIVE_MAGIC[index])) {
    throw new WorkerCompilationError("INVALID_INPUT", "Compiler archive magic is invalid.");
  }
  const manifestAndFileCount = await reader.readBytes(8);
  const manifestAndFileCountView = new DataView(
    manifestAndFileCount.buffer,
    manifestAndFileCount.byteOffset,
    manifestAndFileCount.byteLength,
  );
  const manifestLength = manifestAndFileCountView.getUint32(0, false);
  const fileCount = manifestAndFileCountView.getUint32(4, false);
  if (fileCount > MAX_COMPILER_ARCHIVE_FILES) {
    throw new WorkerCompilationError(
      "INVALID_INPUT",
      `Compiler archive exceeds the ${MAX_COMPILER_ARCHIVE_FILES} file limit.`,
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(textDecoder.decode(await reader.readBytes(manifestLength)));
  } catch (error) {
    throw new WorkerCompilationError(
      "INVALID_INPUT",
      "Compiler archive manifest is invalid JSON.",
      {
        cause: error,
      },
    );
  }

  let filesRead = false;
  const files: AsyncIterable<CompilerArchiveFileEntry> = {
    async *[Symbol.asyncIterator]() {
      if (filesRead) {
        throw new WorkerCompilationError(
          "INVALID_INPUT",
          "Compiler archive files can only be read once.",
        );
      }
      filesRead = true;
      const paths = new Set<string>();
      let complete = false;

      try {
        for (let index = 0; index < fileCount; index += 1) {
          const fileHeader = await reader.readBytes(8);
          const fileHeaderView = new DataView(
            fileHeader.buffer,
            fileHeader.byteOffset,
            fileHeader.byteLength,
          );
          const pathLength = fileHeaderView.getUint32(0, false);
          const contentLength = fileHeaderView.getUint32(4, false);
          if (pathLength === 0 || pathLength > MAX_COMPILER_FILE_PATH_BYTES) {
            throw new WorkerCompilationError(
              "INVALID_INPUT",
              "Compiler archive file path length is invalid.",
            );
          }
          const path = textDecoder.decode(await reader.readBytes(pathLength));
          validateCompilerArchivePath(path);
          if (paths.has(path)) {
            throw new WorkerCompilationError(
              "INVALID_INPUT",
              `Compiler archive contains duplicate path '${path}'.`,
            );
          }
          paths.add(path);
          yield [path, textDecoder.decode(await reader.readBytes(contentLength))] as const;
        }
        await reader.assertComplete();
        complete = true;
      } finally {
        if (!complete) {
          await reader.cancel();
        }
      }
    },
  };

  return {
    manifest,
    files,
    cancel: async (reason) => {
      await reader.cancel(reason);
    },
  };
}

async function materializeCompilerArchiveFiles(files: AsyncIterable<CompilerArchiveFileEntry>) {
  const materializedFiles = Object.create(null) as Record<string, string>;
  for await (const [path, content] of files) {
    materializedFiles[path] = content;
  }
  return materializedFiles;
}

function parseProtocolVersion(manifest: Record<string, unknown>) {
  if (manifest.protocolVersion !== 1) {
    throw new WorkerCompilationError("INVALID_INPUT", "Compiler protocol version must be 1.");
  }
}

/** Creates the streamed compiler-service request for one Worker build. */
export function createCompileWorkerServiceRequest(input: CompileWorkerInput) {
  return createCompilerServiceRequest(
    "/compile-worker",
    {
      protocolVersion: 1,
      operation: "compile-worker",
      entryPoint: input.entryPoint,
      dependencies: input.dependencies,
      runtime: input.runtime,
    } satisfies CompileWorkerRequestManifest,
    createCompilerArchiveFileSources(input.files),
  );
}

/** Parses and validates one streamed Worker build request at the compiler boundary. */
export async function readCompileWorkerServiceRequest(
  request: Request,
): Promise<CompileWorkerInput> {
  const archive = await readCompilerArchive(request);
  assertObject(archive.manifest, "Compiler archive manifest");
  parseProtocolVersion(archive.manifest);
  if (archive.manifest.operation !== "compile-worker") {
    throw new WorkerCompilationError(
      "INVALID_INPUT",
      "Compiler archive operation must be compile-worker.",
    );
  }
  assertObject(archive.manifest.runtime, "Compiler runtime");
  return {
    files: await materializeCompilerArchiveFiles(archive.files),
    entryPoint: parseString(archive.manifest.entryPoint, "Compiler entry point"),
    dependencies: parseStringRecord(archive.manifest.dependencies, "Compiler dependencies"),
    runtime: {
      compatibilityDate: parseString(
        archive.manifest.runtime.compatibilityDate,
        "Compiler compatibility date",
      ),
      compatibilityFlags: parseStringArray(
        archive.manifest.runtime.compatibilityFlags,
        "Compiler compatibility flags",
      ),
    },
  };
}

/** Creates the streamed compiler-service request for one TypeScript check. */
export function createTypeCheckFilesServiceRequest(input: TypeCheckFilesInput) {
  return createCompilerServiceRequest(
    "/type-check-files",
    {
      protocolVersion: 1,
      operation: "type-check-files",
      sourcePaths: input.sourcePaths,
    } satisfies TypeCheckFilesRequestManifest,
    input.files,
  );
}

/** Parses and validates one streamed TypeScript check request at the compiler boundary. */
export async function readTypeCheckFilesServiceRequest(
  request: Request,
): Promise<TypeCheckProjectInput> {
  const archive = await readCompilerArchive(request);
  assertObject(archive.manifest, "Compiler archive manifest");
  parseProtocolVersion(archive.manifest);
  if (archive.manifest.operation !== "type-check-files") {
    throw new WorkerCompilationError(
      "INVALID_INPUT",
      "Compiler archive operation must be type-check-files.",
    );
  }
  return {
    files: archive.files,
    sourcePaths: parseStringArray(archive.manifest.sourcePaths, "Type-check source paths"),
  };
}

/** Serializes one successful Worker build without the RPC structured-clone size limit. */
export function createCompileWorkerServiceResponse(result: CompiledWorker) {
  return new Response(
    createCompilerArchiveBody(
      {
        protocolVersion: 1,
        operation: "compile-worker-result",
        mainModule: result.bundle.mainModule,
        warnings: result.warnings,
        runtime: result.bundle.runtime,
      } satisfies CompileWorkerResponseManifest,
      createCompilerArchiveFileSources(result.bundle.modules),
    ),
    { headers: { "content-type": COMPILER_ARCHIVE_CONTENT_TYPE } },
  );
}

/** Deserializes one successful Worker build or raises the compiler's typed failure. */
export async function readCompileWorkerServiceResponse(
  response: Response,
): Promise<CompiledWorker> {
  if (!response.ok) {
    throw await readCompilerServiceError(response);
  }
  const archive = await readCompilerArchive(response);
  assertObject(archive.manifest, "Compiler result manifest");
  parseProtocolVersion(archive.manifest);
  if (archive.manifest.operation !== "compile-worker-result") {
    throw new WorkerCompilationError(
      "INVALID_INPUT",
      "Compiler result operation must be compile-worker-result.",
    );
  }
  assertObject(archive.manifest.runtime, "Compiler result runtime");
  const modules = await materializeCompilerArchiveFiles(archive.files);
  return {
    bundle: createWorkerBundle({
      mainModule: parseString(archive.manifest.mainModule, "Compiler result main module"),
      modules,
      runtime: {
        compatibilityDate: parseString(
          archive.manifest.runtime.compatibilityDate,
          "Compiler result compatibility date",
        ),
        compatibilityFlags: parseStringArray(
          archive.manifest.runtime.compatibilityFlags,
          "Compiler result compatibility flags",
        ),
      },
    }),
    warnings: parseStringArray(archive.manifest.warnings, "Compiler result warnings"),
  };
}

function parseNullableNumber(value: unknown, name: string) {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new WorkerCompilationError("INVALID_INPUT", `${name} must be an integer or null.`);
  }
  return value;
}

function parseNullableString(value: unknown, name: string) {
  if (value === null) {
    return null;
  }
  return parseString(value, name);
}

function parseTypeCheckDiagnostic(value: unknown, index: number): TypeCheckDiagnostic {
  const name = `Type-check diagnostic ${index}`;
  assertObject(value, name);
  const code = value.code;
  if (typeof code !== "number" || !Number.isInteger(code)) {
    throw new WorkerCompilationError("INVALID_INPUT", `${name}.code must be an integer.`);
  }
  return {
    code,
    path: parseNullableString(value.path, `${name}.path`),
    line: parseNullableNumber(value.line, `${name}.line`),
    column: parseNullableNumber(value.column, `${name}.column`),
    message: parseString(value.message, `${name}.message`),
  };
}

/** Serializes one successful TypeScript check response. */
export function createTypeCheckFilesServiceResponse(result: TypeCheckFilesResult) {
  return Response.json(result);
}

/** Deserializes one successful TypeScript check or raises the compiler's typed failure. */
export async function readTypeCheckFilesServiceResponse(
  response: Response,
): Promise<TypeCheckFilesResult> {
  if (!response.ok) {
    throw await readCompilerServiceError(response);
  }
  const value: unknown = await response.json();
  assertObject(value, "Type-check result");
  if (!Array.isArray(value.diagnostics)) {
    throw new WorkerCompilationError("INVALID_INPUT", "Type-check diagnostics must be an array.");
  }
  return {
    diagnostics: value.diagnostics.map(parseTypeCheckDiagnostic),
  };
}

/** Converts a compiler failure into the private service's stable error response. */
export function createCompilerServiceErrorResponse(error: unknown) {
  const body: CompilerErrorResponse =
    error instanceof WorkerCompilationError
      ? { code: error.code, message: error.message }
      : {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        };
  return Response.json(body, { status: error instanceof WorkerCompilationError ? 400 : 500 });
}

async function readCompilerServiceError(response: Response) {
  const value: unknown = await response.json();
  assertObject(value, "Compiler error response");
  const code = parseString(value.code, "Compiler error code");
  const message = parseString(value.message, "Compiler error message");
  if (
    code !== "INVALID_INPUT" &&
    code !== "DEPENDENCY_INSTALL_FAILED" &&
    code !== "UNSUPPORTED_MODULE" &&
    code !== "INTERNAL_ERROR"
  ) {
    throw new WorkerCompilationError(
      "INTERNAL_ERROR",
      `Compiler returned unknown error code '${code}'.`,
    );
  }
  return new WorkerCompilationError(code, message);
}
