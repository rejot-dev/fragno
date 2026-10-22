import { expect, test, assert } from "vitest";

import { env } from "cloudflare:workers";
import { packTar, unpackTar } from "modern-tar";

const FILE_COUNT = 150;

async function createLink(upload: DurableObjectStub, access: "read" | "write") {
  const response = await upload.fetch(
    "https://upload.internal/api/upload/file-links?provider=database",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "database",
        access,
        target: { kind: "glob", glob: "repo/**" },
        expiresInSeconds: 600,
      }),
    },
  );
  const { token } = (await response.json()) as { token: string };
  return `https://upload.internal/api/upload/file-links/${token}/archive.tar?provider=database`;
}

// Durable Object SQLite binds at most 100 parameters per statement, which plain SQLite tests miss.
// The first request loads Upload's module graph through Vite, which takes around 20 seconds.
test(
  "a folder archive larger than one parameter batch round-trips through Durable Object SQLite",
  {
    timeout: 60_000,
  },
  async () => {
    const upload = env.UPLOAD.getByName(`v1:org:file-links-${crypto.randomUUID()}`);
    const files = Array.from({ length: FILE_COUNT }, (_, index) => ({
      name: `src/module-${index}.ts`,
      content: `export const value = ${index};\n`,
    }));

    const pushed = await upload.fetch(await createLink(upload, "write"), {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(
        await packTar(
          files.map(({ name, content }) => ({
            header: { name, size: new TextEncoder().encode(content).byteLength },
            body: content,
          })),
        ),
      ),
    });
    expect(pushed.status, await pushed.clone().text()).toBe(200);
    expect(await pushed.json()).toMatchObject({ fileCount: FILE_COUNT });

    const pulled = await upload.fetch(await createLink(upload, "read"));
    assert(pulled.status === 200);
    const entries = await unpackTar(new Uint8Array(await pulled.arrayBuffer()));
    expect(
      entries
        .map(({ header, data }) => ({ name: header.name, content: new TextDecoder().decode(data) }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ).toEqual(files.sort((left, right) => left.name.localeCompare(right.name)));
  },
);
