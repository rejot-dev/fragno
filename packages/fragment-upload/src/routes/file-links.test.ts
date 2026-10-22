import { afterAll, assert, beforeEach, describe, expect, it, vi } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { packTar, unpackTar, type TarEntry } from "modern-tar";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { uploadFragmentDefinition } from "../definition";
import type { FileLinksConfig } from "../file-links";
import { createFilesystemStorageAdapter } from "../storage/fs";
import { uploadRoutes } from "./index";

describe("file links", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragno-upload-file-links-"));
  const storage = createFilesystemStorageAdapter({ rootDir });
  const provider = storage.name;
  const fileLinks: FileLinksConfig = {
    secret: "file-link-test-secret",
    audience: "workspace-a",
    contentTypeForKey: (fileKey) => (fileKey.endsWith(".csv") ? "text/csv" : "text/plain"),
    maxArchiveWriteFiles: 2,
    maxArchiveWriteBytes: 32,
  };
  const testSetup = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withDbRoundtripGuard({ maxRoundtrips: 3 })
    .withFragment(
      "upload",
      instantiate(uploadFragmentDefinition)
        .withConfig({ storage, fileLinks, maxSingleUploadBytes: 20 })
        .withRoutes(uploadRoutes),
    )
    .build();
  const { fragment } = testSetup.fragments.upload;
  const otherAudienceSetup = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "upload",
      instantiate(uploadFragmentDefinition)
        .withConfig({ storage, fileLinks: { ...fileLinks, audience: "workspace-b" } })
        .withRoutes(uploadRoutes),
    )
    .build();

  const send = (
    target: typeof fragment,
    pathname: string,
    init?: RequestInit & { contentLength?: number },
  ) =>
    target.handler(
      new Request(`http://localhost${target.mountRoute}${pathname}`, {
        ...init,
        headers: {
          ...(init?.body ? { "content-type": "application/octet-stream" } : {}),
          ...(init?.contentLength === undefined
            ? {}
            : { "content-length": String(init.contentLength) }),
        },
      }),
    );

  const createLink = async (
    access: "read" | "write",
    target: { kind: "file"; fileKey: string } | { kind: "glob"; glob: string },
    expiresInSeconds = 60,
  ) => {
    const response = await fragment.callRoute("POST", "/file-links", {
      body: { provider, access, target, expiresInSeconds },
    });
    assert(response.type === "json");
    return response.data.token;
  };

  const writeFile = async (fileKey: string, content: string) => {
    const form = new FormData();
    form.set("file", new File([content], path.basename(fileKey), { type: "text/plain" }));
    form.set("provider", provider);
    form.set("fileKey", fileKey);
    const response = await fragment.callRoute("POST", "/files", { body: form });
    assert(response.type === "json");
  };

  const readFile = async (fileKey: string) => {
    const response = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: fileKey },
    });
    return response.status === 200 ? await response.text() : null;
  };

  const getFile = async (fileKey: string) => {
    const response = await fragment.callRoute("GET", "/files/by-key", {
      query: { provider, key: fileKey },
    });
    assert(response.type === "json");
    return response.data;
  };

  // Request bodies need ArrayBuffer-backed bytes, so the packed archive is copied once.
  const tar = async (entries: { name: string; content?: string; type?: "directory" }[]) =>
    new Uint8Array(
      await packTar(
        entries.map(
          ({ name, content, type }): TarEntry =>
            type === "directory"
              ? { header: { name, size: 0, type } }
              : {
                  header: { name, size: new TextEncoder().encode(content).byteLength },
                  body: content,
                },
        ),
      ),
    );

  beforeEach(async () => {
    vi.useRealTimers();
    await testSetup.test.resetDatabase();
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.mkdir(rootDir, { recursive: true });
  });

  afterAll(async () => {
    await testSetup.test.cleanup();
    await otherAudienceSetup.test.cleanup();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("moves a folder out as an archive and a sandbox's output back in as one batch", async () => {
    await writeFile("data/a.txt", "alpha");
    await writeFile("data/sub/b.csv", "x,y");
    await writeFile("datasets/c.txt", "outside the folder");
    await writeFile("other/d.txt", "outside the glob");

    const readToken = await createLink("read", { kind: "glob", glob: "data/**" });
    const archive = await send(fragment, `/file-links/${readToken}/archive.tar`);
    assert(archive.status === 200);
    assert(archive.headers.get("content-type") === "application/x-tar");
    assert(!archive.headers.has("x-next-cursor"));
    const entries = await unpackTar(new Uint8Array(await archive.arrayBuffer()));
    expect(
      entries.map(({ header, data }) => [header.name, new TextDecoder().decode(data)]),
    ).toEqual([
      ["a.txt", "alpha"],
      ["sub/b.csv", "x,y"],
    ]);

    const writeToken = await createLink("write", { kind: "glob", glob: "data/**" });
    const pushed = await send(fragment, `/file-links/${writeToken}/archive.tar`, {
      method: "PUT",
      body: await tar([
        { name: "./", type: "directory" },
        { name: "./a.txt", content: "alpha, rewritten" },
        { name: "results/", type: "directory" },
        { name: "results/summary.csv", content: "total,2" },
      ]),
    });
    assert(pushed.status === 200);
    expect(await pushed.json()).toEqual({ fileCount: 2, sizeBytes: 23 });
    await expect(readFile("data/a.txt")).resolves.toBe("alpha, rewritten");
    await expect(readFile("data/results/summary.csv")).resolves.toBe("total,2");
    await expect(getFile("data/results/summary.csv")).resolves.toMatchObject({
      contentType: "text/csv",
      status: "ready",
    });
    await expect(readFile("data/sub/b.csv")).resolves.toBe("x,y");
  });

  it("reads a folder archive no faster than the downloader consumes it", async () => {
    // Larger than the archive stream's 8 MiB buffer, so an unread download must stall the reads.
    const fileBytes = 5 * 1024 * 1024;
    for (const name of ["one", "two", "three"]) {
      await writeFile(`large/${name}.bin`, "x".repeat(fileBytes));
    }
    const reads = vi.spyOn(storage, "getDownloadStream");
    try {
      const readToken = await createLink("read", { kind: "glob", glob: "large/**" });
      const archive = await send(fragment, `/file-links/${readToken}/archive.tar`);
      assert(archive.status === 200);

      await vi.waitFor(() => expect(reads).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(reads.mock.calls.length).toBeLessThan(3);

      const entries = await unpackTar(new Uint8Array(await archive.arrayBuffer()));
      expect(entries.map(({ header, data }) => [header.name, data?.byteLength])).toEqual([
        ["one.bin", fileBytes],
        ["three.bin", fileBytes],
        ["two.bin", fileBytes],
      ]);
    } finally {
      reads.mockRestore();
    }
  });

  it("rejects a whole archive that escapes the link's glob, exceeds its limits, or is not a whole tar", async () => {
    await writeFile("out/kept.txt", "before");
    const writeToken = await createLink("write", { kind: "glob", glob: "out/*.txt" });

    for (const name of ["nested/deep.txt", "../escape.txt", "/etc/passwd.txt", "notes.md"]) {
      const response = await send(fragment, `/file-links/${writeToken}/archive.tar`, {
        method: "PUT",
        body: await tar([
          { name: "kept.txt", content: "overwritten" },
          { name, content: "outside" },
        ]),
      });
      expect(response.status, name).toBe(403);
      expect(await response.json()).toMatchObject({ code: "FILE_LINK_FORBIDDEN" });
    }

    const gzipped = await send(fragment, `/file-links/${writeToken}/archive.tar`, {
      method: "PUT",
      body: new Uint8Array(
        await new Response(
          new Blob([await tar([{ name: "kept.txt", content: "overwritten" }])])
            .stream()
            .pipeThrough(new CompressionStream("gzip")),
        ).arrayBuffer(),
      ),
    });
    assert(gzipped.status === 400);
    expect(await gzipped.json()).toMatchObject({ code: "INVALID_REQUEST" });

    // A push whose connection drops inside its second entry, after the first entry was staged.
    const truncated = await tar([
      { name: "kept.txt", content: "overwritten" },
      { name: "partial.txt", content: "partial" },
    ]);
    const received = [truncated.slice(0, 3 * 512 + 3)];
    const cutOff = await send(fragment, `/file-links/${writeToken}/archive.tar`, {
      method: "PUT",
      duplex: "half",
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          const chunk = received.shift();
          if (chunk) {
            controller.enqueue(chunk);
            return;
          }
          // Ending only after a pause lets the server start on the cut-off entry first.
          await new Promise((resolve) => setTimeout(resolve, 20));
          controller.close();
        },
      }),
    } as RequestInit);
    assert(cutOff.status === 400);
    expect(await cutOff.json()).toMatchObject({ code: "INVALID_REQUEST" });

    for (const entries of [
      [
        { name: "kept.txt", content: "overwritten" },
        { name: "b.txt", content: "b" },
        { name: "c.txt", content: "c" },
      ],
      [
        { name: "kept.txt", content: "x".repeat(16) },
        { name: "big.txt", content: "x".repeat(17) },
      ],
    ]) {
      const oversized = await send(fragment, `/file-links/${writeToken}/archive.tar`, {
        method: "PUT",
        body: await tar(entries),
      });
      assert(oversized.status === 400);
      expect(await oversized.json()).toMatchObject({
        message:
          "Archives may contain at most 2 files and 32 bytes; upload only the files you need.",
      });
    }

    const oversizedFile = await send(fragment, `/file-links/${writeToken}/archive.tar`, {
      method: "PUT",
      body: await tar([
        { name: "kept.txt", content: "overwritten" },
        { name: "big.txt", content: "x".repeat(21) },
      ]),
    });
    assert(oversizedFile.status === 413);
    expect(await oversizedFile.json()).toMatchObject({
      message: "File 'out/big.txt' is 21 bytes; files may be at most 20 bytes.",
    });

    await expect(readFile("out/kept.txt")).resolves.toBe("before");
    const listed = await fragment.callRoute("GET", "/files", {
      query: { provider, prefix: "" },
    });
    assert(listed.type === "json");
    expect(listed.data.files.map((file) => file.fileKey)).toEqual(["out/kept.txt"]);
    const storedObjects = await fs.readdir(rootDir, { recursive: true, withFileTypes: true });
    expect(storedObjects.filter((entry) => entry.isFile())).toHaveLength(1);
  });

  it("reads and replaces one file, and grants nothing beyond its file, access, audience, or lifetime", async () => {
    await writeFile("reports/q1.txt", "draft");
    const readToken = await createLink("read", { kind: "file", fileKey: "reports/q1.txt" });
    const writeToken = await createLink("write", { kind: "file", fileKey: "reports/q1.txt" });

    const read = await send(fragment, `/file-links/${readToken}`);
    assert(read.status === 200);
    assert((await read.text()) === "draft");

    const replaced = await send(fragment, `/file-links/${writeToken}`, {
      method: "PUT",
      body: "final",
      contentLength: 5,
    });
    assert(replaced.status === 200);
    await expect(readFile("reports/q1.txt")).resolves.toBe("final");

    const writeWithReadLink = await send(fragment, `/file-links/${readToken}`, {
      method: "PUT",
      body: "nope",
      contentLength: 4,
    });
    assert(writeWithReadLink.status === 403);
    expect(await writeWithReadLink.json()).toMatchObject({ code: "FILE_LINK_FORBIDDEN" });

    const missingLength = await send(fragment, `/file-links/${writeToken}`, {
      method: "PUT",
      body: "final",
    });
    assert(missingLength.status === 411);

    const oversized = await send(fragment, `/file-links/${writeToken}`, {
      method: "PUT",
      body: "x".repeat(21),
      contentLength: 21,
    });
    assert(oversized.status === 413);
    await expect(readFile("reports/q1.txt")).resolves.toBe("final");

    const fileLinkArchive = await send(fragment, `/file-links/${readToken}/archive.tar`);
    assert(fileLinkArchive.status === 400);

    const [payload, signature] = readToken.split(".");
    const widened = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString()),
        target: { kind: "glob", glob: "**" },
      }),
    ).toString("base64url");
    for (const token of [`${widened}.${signature}`, `${payload}.${signature}x`, "garbage"]) {
      const response = await send(fragment, `/file-links/${token}`);
      expect(response.status, token).toBe(403);
      expect(await response.json()).toMatchObject({ code: "FILE_LINK_INVALID" });
    }

    const otherAudience = await send(
      otherAudienceSetup.fragments.upload.fragment,
      `/file-links/${readToken}`,
    );
    assert(otherAudience.status === 403);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    const expired = await send(fragment, `/file-links/${readToken}`);
    assert(expired.status === 410);
    expect(await expired.json()).toMatchObject({ code: "FILE_LINK_EXPIRED" });
  });
});
