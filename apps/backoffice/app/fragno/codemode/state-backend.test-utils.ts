import { globToRegExp, searchTextContent } from "@fragno-dev/upload/text-index";

import type { FetchObject } from "@/backoffice-runtime/object-registry";

import { createBackofficeStateBackend, type BackofficeStateBackend } from "./state-backend";

export const createTestStateBackend = ({
  upload = new MemoryUploadObject(),
  staticFiles = {},
  onResolveStaticFiles,
}: {
  upload?: MemoryUploadObject;
  staticFiles?: Record<string, string | Uint8Array>;
  onResolveStaticFiles?: () => void;
} = {}): BackofficeStateBackend =>
  createBackofficeStateBackend({
    uploadObject: upload,
    staticFileArtifacts: () => {
      onResolveStaticFiles?.();
      return staticFiles;
    },
  });

type MemoryUploadRecord = {
  fileKey: string;
  filename: string;
  content: Uint8Array;
  contentType: string;
  metadata: Record<string, unknown> | null;
  updatedAt: string;
  status: "ready" | "deleted";
  revision: number;
};

type MemoryPreparedUpload = {
  uploadId: string;
  fileKey: string;
  filename: string;
  contentType: string;
  content: Uint8Array | null;
  expiresAt: string;
};

type MemoryWritePrecondition = { kind: "absent" } | { kind: "revision"; revision: number };

type MemoryPreparedBatchEntry =
  | { kind: "write"; uploadId: string; precondition: MemoryWritePrecondition }
  | {
      kind: "delete";
      provider: string;
      fileKey: string;
      precondition: Extract<MemoryWritePrecondition, { kind: "revision" }>;
    };

export class MemoryUploadObject implements FetchObject {
  readonly requests: string[] = [];
  readonly listPrefixes: string[] = [];
  readonly listGlobs: string[] = [];
  readonly #records = new Map<string, MemoryUploadRecord>();
  readonly #preparedUploads = new Map<string, MemoryPreparedUpload>();
  #nextUploadId = 1;
  #beforeNextWrite: (() => void | Promise<void>) | undefined;

  constructor(files: Record<string, string | Uint8Array> = {}) {
    for (const [fileKey, content] of Object.entries(files)) {
      this.#setFile(fileKey, content, inferTestContentType(fileKey), null);
    }
  }

  beforeNextWrite(callback: () => void | Promise<void>): void {
    this.#beforeNextWrite = callback;
  }

  replaceFile(fileKey: string, content: string | Uint8Array): void {
    const existing = this.#records.get(fileKey);
    this.#setFile(
      fileKey,
      content,
      existing?.contentType ?? inferTestContentType(fileKey),
      existing?.metadata ?? null,
      existing?.filename,
    );
  }

  readyKeys(): string[] {
    const readyKeys: string[] = [];
    for (const record of this.#records.values()) {
      if (record.status === "ready") {
        readyKeys.push(record.fileKey);
      }
    }
    return readyKeys.sort();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.requests.push(`${request.method} ${url.pathname}`);

    if (request.method === "GET" && url.pathname === "/api/upload/files") {
      this.listPrefixes.push(url.searchParams.get("prefix") ?? "");
      this.listGlobs.push(url.searchParams.get("glob") ?? "");
      return this.#listFiles(url);
    }
    if (request.method === "GET" && url.pathname === "/api/upload/files/by-key") {
      return this.#getFile(url);
    }
    if (request.method === "GET" && url.pathname === "/api/upload/files/by-key/content") {
      return this.#readFile(url);
    }
    if (request.method === "POST" && url.pathname === "/api/upload/files/search") {
      return await this.#searchCandidates(request);
    }
    if (request.method === "POST" && url.pathname === "/api/upload/files/search/hydrate") {
      return await this.#hydrateSearch(request);
    }
    if (request.method === "POST" && url.pathname === "/api/upload/files") {
      return await this.#writeFile(request);
    }
    if (request.method === "POST" && url.pathname === "/api/upload/uploads") {
      return await this.#createPreparedUpload(request);
    }
    const preparedContentMatch = /^\/api\/upload\/uploads\/([^/]+)\/content$/.exec(url.pathname);
    if (request.method === "PUT" && preparedContentMatch?.[1]) {
      return await this.#writePreparedUploadContent(preparedContentMatch[1], request);
    }
    if (request.method === "POST" && url.pathname === "/api/upload/files/commit-prepared") {
      return await this.#commitPreparedFiles(request);
    }
    if (request.method === "DELETE" && url.pathname === "/api/upload/files/by-key") {
      return await this.#deleteFile(url);
    }

    return Response.json({ message: "Not found", code: "FILE_NOT_FOUND" }, { status: 404 });
  }

  #getFile(url: URL): Response {
    const record = this.#records.get(url.searchParams.get("key") ?? "");
    if (!record) {
      return Response.json({ message: "File not found", code: "FILE_NOT_FOUND" }, { status: 404 });
    }
    return Response.json({
      fileKey: record.fileKey,
      uploaderId: null,
      filename: record.filename,
      sizeBytes: record.content.byteLength,
      contentType: record.contentType,
      checksum: null,
      visibility: "private",
      tags: null,
      metadata: record.metadata,
      status: record.status,
      provider: "database",
      createdAt: record.updatedAt,
      updatedAt: record.updatedAt,
      completedAt: record.updatedAt,
      deletedAt: record.status === "deleted" ? record.updatedAt : null,
      errorCode: null,
      errorMessage: null,
      revision: record.revision,
    });
  }

  #listFiles(url: URL): Response {
    const prefix = url.searchParams.get("prefix") ?? "";
    const glob = url.searchParams.get("glob");
    const globPattern = glob ? globToRegExp(glob) : null;
    const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const records = [...this.#records.values()]
      .filter(
        (record) =>
          record.status === "ready" &&
          record.fileKey.startsWith(prefix) &&
          (!globPattern || globPattern.test(record.fileKey)),
      )
      .sort((left, right) => left.fileKey.localeCompare(right.fileKey));
    const page = records.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;

    return Response.json({
      files: page.map((record) => ({
        provider: "database",
        fileKey: record.fileKey,
        filename: record.filename,
        sizeBytes: record.content.byteLength,
        contentType: record.contentType,
        metadata: record.metadata,
        updatedAt: record.updatedAt,
        status: record.status,
        deletedAt: null,
      })),
      ...(nextOffset < records.length ? { cursor: String(nextOffset) } : {}),
      hasNextPage: nextOffset < records.length,
    });
  }

  #readFile(url: URL): Response {
    const record = this.#records.get(url.searchParams.get("key") ?? "");
    if (record?.status !== "ready") {
      return Response.json({ message: "File not found", code: "FILE_NOT_FOUND" }, { status: 404 });
    }
    return new Response(Uint8Array.from(record.content).buffer, {
      headers: {
        "content-type": record.contentType,
        "content-length": String(record.content.byteLength),
      },
    });
  }

  async #writeFile(request: Request): Promise<Response> {
    const form = await request.formData();
    const fileKey = String(form.get("fileKey") ?? "");
    const file = form.get("file");
    if (!fileKey || !(file instanceof Blob)) {
      return Response.json(
        { message: "Invalid request", code: "INVALID_REQUEST" },
        { status: 400 },
      );
    }
    const beforeWrite = this.#beforeNextWrite;
    this.#beforeNextWrite = undefined;
    await beforeWrite?.();

    const preconditionValue = form.get("precondition");
    const precondition =
      typeof preconditionValue === "string"
        ? (JSON.parse(preconditionValue) as
            | { kind: "absent" }
            | { kind: "revision"; revision: number })
        : undefined;
    const existing = this.#records.get(fileKey);
    const preconditionFailed =
      (precondition?.kind === "absent" && existing?.status === "ready") ||
      (precondition?.kind === "revision" &&
        (existing?.status !== "ready" || existing.revision !== precondition.revision));
    if (preconditionFailed) {
      return Response.json(
        {
          message: "File precondition failed",
          code: "FILE_PRECONDITION_FAILED",
        },
        { status: 409 },
      );
    }

    const metadataValue = form.get("metadata");
    const metadata =
      typeof metadataValue === "string" && metadataValue
        ? (JSON.parse(metadataValue) as Record<string, unknown>)
        : null;
    const content = new Uint8Array(await file.arrayBuffer());
    const record = this.#setFile(
      fileKey,
      content,
      file.type || "application/octet-stream",
      metadata,
      String(form.get("filename") ?? fileKey.split("/").at(-1) ?? "file"),
    );
    return Response.json({
      provider: "database",
      fileKey: record.fileKey,
      filename: record.filename,
      sizeBytes: record.content.byteLength,
      contentType: record.contentType,
      metadata: record.metadata,
      updatedAt: record.updatedAt,
      status: record.status,
    });
  }

  async #deleteFile(url: URL): Promise<Response> {
    const key = url.searchParams.get("key") ?? "";
    const record = this.#records.get(key);
    if (record?.status !== "ready") {
      return Response.json({ message: "File not found", code: "FILE_NOT_FOUND" }, { status: 404 });
    }

    record.status = "deleted";
    return Response.json({ ok: true });
  }

  async #createPreparedUpload(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      fileKey: string;
      filename: string;
      contentType: string;
      publicationMode?: string;
    };
    if (!body.fileKey || body.publicationMode !== "batch") {
      return Response.json(
        { message: "Invalid request", code: "INVALID_REQUEST" },
        { status: 400 },
      );
    }

    const uploadId = `prepared-${this.#nextUploadId++}`;
    const expiresAt = new Date("2027-01-01T00:00:00.000Z").toISOString();
    this.#preparedUploads.set(uploadId, {
      uploadId,
      fileKey: body.fileKey,
      filename: body.filename,
      contentType: body.contentType,
      content: null,
      expiresAt,
    });
    return Response.json({
      uploadId,
      fileKey: body.fileKey,
      status: "created",
      strategy: "proxy",
      publicationMode: "batch",
      expiresAt,
      provider: "database",
      upload: {
        mode: "single",
        transport: "proxy",
        statusEndpoint: `/uploads/${uploadId}`,
        progressEndpoint: `/uploads/${uploadId}/progress`,
        completeEndpoint: `/uploads/${uploadId}/complete`,
        abortEndpoint: `/uploads/${uploadId}/abort`,
        contentEndpoint: `/uploads/${uploadId}/content`,
      },
    });
  }

  async #writePreparedUploadContent(uploadId: string, request: Request): Promise<Response> {
    const upload = this.#preparedUploads.get(uploadId);
    if (!upload) {
      return Response.json(
        { message: "Upload not found", code: "UPLOAD_NOT_FOUND" },
        { status: 404 },
      );
    }

    upload.content = new Uint8Array(await request.arrayBuffer());
    return Response.json({
      kind: "prepared",
      write: {
        uploadId,
        provider: "database",
        fileKey: upload.fileKey,
        objectKey: `prepared/${uploadId}`,
        sizeBytes: upload.content.byteLength,
        contentType: upload.contentType,
        checksum: null,
        expiresAt: upload.expiresAt,
      },
    });
  }

  async #commitPreparedFiles(request: Request): Promise<Response> {
    const body = (await request.json()) as { entries: MemoryPreparedBatchEntry[] };
    const beforeWrite = this.#beforeNextWrite;
    this.#beforeNextWrite = undefined;
    await beforeWrite?.();

    for (const entry of body.entries) {
      if (entry.kind === "write") {
        const upload = this.#preparedUploads.get(entry.uploadId);
        if (!upload?.content || !this.#matchesPrecondition(upload.fileKey, entry.precondition)) {
          return this.#preconditionFailedResponse();
        }
      } else if (!this.#matchesPrecondition(entry.fileKey, entry.precondition)) {
        return this.#preconditionFailedResponse();
      }
    }

    const files = body.entries.map((entry) => {
      if (entry.kind === "write") {
        const upload = this.#preparedUploads.get(entry.uploadId)!;
        const record = this.#setFile(
          upload.fileKey,
          upload.content!,
          upload.contentType,
          null,
          upload.filename,
        );
        this.#preparedUploads.delete(entry.uploadId);
        return this.#toMutationSnapshot(record);
      }

      const record = this.#records.get(entry.fileKey)!;
      record.status = "deleted";
      record.revision += 1;
      return this.#toMutationSnapshot(record);
    });

    return Response.json({ files });
  }

  #matchesPrecondition(fileKey: string, precondition: MemoryWritePrecondition): boolean {
    const record = this.#records.get(fileKey);
    return precondition.kind === "absent"
      ? record?.status !== "ready"
      : record?.status === "ready" && record.revision === precondition.revision;
  }

  #preconditionFailedResponse(): Response {
    return Response.json(
      { message: "File precondition failed", code: "FILE_PRECONDITION_FAILED" },
      { status: 409 },
    );
  }

  #toMutationSnapshot(record: MemoryUploadRecord) {
    return {
      fileKey: record.fileKey,
      uploaderId: null,
      filename: record.filename,
      sizeBytes: record.content.byteLength,
      contentType: record.contentType,
      checksum: null,
      visibility: "private",
      tags: null,
      metadata: record.metadata,
      status: record.status,
      provider: "database",
      errorCode: null,
      errorMessage: null,
      revision: record.revision,
    };
  }

  async #searchCandidates(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      glob: string;
      query: string;
      maxCandidateFiles?: number;
      cursor?: string;
    };
    const expression = globToRegExp(body.glob);
    const query = body.query.toLocaleLowerCase();
    const matching = [...this.#records.values()]
      .filter(
        (record) =>
          record.status === "ready" &&
          expression.test(record.fileKey) &&
          new TextDecoder().decode(record.content).toLocaleLowerCase().includes(query),
      )
      .sort((left, right) => left.fileKey.localeCompare(right.fileKey));
    const offset = Number(body.cursor ?? 0);
    const pageSize = body.maxCandidateFiles ?? 20;
    const page = matching.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;

    return Response.json({
      provider: "database",
      candidates: page.map((record) => ({
        key: record.fileKey,
        positions: [0],
        count: 1,
      })),
      candidateFiles: page.length,
      ...(nextOffset < matching.length ? { cursor: String(nextOffset) } : {}),
      hasMoreCandidates: nextOffset < matching.length,
    });
  }

  async #hydrateSearch(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      candidateKeys: string[];
      query: string;
      options?: Parameters<typeof searchTextContent>[3];
      searchOffset?: number;
    };
    const maxMatches = body.options?.maxMatches ?? 50;
    const matches: ReturnType<typeof searchTextContent> = [];
    const skippedCandidates: Array<{ key: string; reason: "not_found" }> = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    let consumedCandidates = 0;
    let currentSearchOffset = body.searchOffset ?? 0;
    let nextSearchOffset: number | undefined;

    for (const key of body.candidateKeys) {
      const record = this.#records.get(key);
      if (record?.status !== "ready") {
        skippedCandidates.push({ key, reason: "not_found" });
        consumedCandidates += 1;
        currentSearchOffset = 0;
        continue;
      }

      scannedFiles += 1;
      scannedBytes += record.content.byteLength;
      const remainingMatches = maxMatches - matches.length;
      const candidateMatches = searchTextContent(
        key,
        new TextDecoder().decode(record.content),
        body.query,
        {
          ...body.options,
          startOffset: currentSearchOffset,
          maxMatches: remainingMatches + 1,
        },
      );
      matches.push(...candidateMatches.slice(0, remainingMatches));
      if (candidateMatches.length > remainingMatches) {
        nextSearchOffset = candidateMatches[remainingMatches]?.startOffset;
        break;
      }

      consumedCandidates += 1;
      currentSearchOffset = 0;
    }

    return Response.json({
      matches,
      scannedFiles,
      scannedBytes,
      consumedCandidates,
      skippedCandidates,
      ...(nextSearchOffset === undefined ? {} : { nextSearchOffset }),
      truncated: nextSearchOffset === undefined ? false : { reason: "max_matches" },
    });
  }

  #setFile(
    fileKey: string,
    content: string | Uint8Array,
    contentType: string,
    metadata: Record<string, unknown> | null,
    filename = fileKey.split("/").at(-1) ?? "file",
  ): MemoryUploadRecord {
    const existing = this.#records.get(fileKey);
    const record: MemoryUploadRecord = {
      fileKey,
      filename,
      content: typeof content === "string" ? new TextEncoder().encode(content) : content,
      contentType,
      metadata,
      updatedAt: new Date().toISOString(),
      status: "ready",
      revision: (existing?.revision ?? -1) + 1,
    };
    this.#records.set(fileKey, record);
    return record;
  }
}

const inferTestContentType = (path: string): string =>
  path.endsWith(".json")
    ? "application/json"
    : path.endsWith(".js")
      ? "text/javascript"
      : path.endsWith(".md")
        ? "text/markdown"
        : "text/plain";
