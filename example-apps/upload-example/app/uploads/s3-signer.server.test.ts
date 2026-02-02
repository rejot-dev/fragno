import { describe, expect, it } from "vitest";

import { createS3Signer } from "./s3-signer.server";

const baseConfig = () => ({
  region: "auto",
  accessKeyId: "AKIA_TEST",
  secretAccessKey: "secret",
  endpoint: "https://s3.example.com/base",
  bucket: "uploads",
  storageKeyPrefix: "direct",
});

const getHeader = (headers: Record<string, string>, name: string) => {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
};

describe("createS3Signer", () => {
  it("signs allowed requests and strips unsafe headers", async () => {
    const signer = createS3Signer(baseConfig());
    const url = "https://uploads.s3.example.com/base/direct/user/avatar.png";

    const signed = await signer.sign({
      method: "POST",
      url,
      headers: {
        "Content-Type": "image/png",
        "x-amz-meta-test": "1",
        "x-evil": "nope",
        host: "evil.example.com",
      },
    });

    expect(signed.url).toContain("uploads.s3.example.com");
    expect(getHeader(signed.headers ?? {}, "host")).toBe("uploads.s3.example.com");
    expect(getHeader(signed.headers ?? {}, "x-amz-meta-test")).toBe("1");
    expect(getHeader(signed.headers ?? {}, "x-evil")).toBeUndefined();
  });

  it("forces unsigned payload headers for presigned requests", async () => {
    const signer = createS3Signer(baseConfig());
    const url = "https://uploads.s3.example.com/base/direct/user/avatar.png";

    const signed = await signer.presign({
      method: "PUT",
      url,
    });

    expect(getHeader(signed.headers ?? {}, "x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
  });

  it("rejects disallowed methods", async () => {
    const signer = createS3Signer(baseConfig());
    const url = "https://uploads.s3.example.com/base/direct/file.bin";

    await expect(
      signer.sign({
        method: "PATCH",
        url,
      }),
    ).rejects.toThrow("Signer refused to sign method");
  });

  it("rejects unexpected hosts", async () => {
    const signer = createS3Signer(baseConfig());
    const url = "https://s3.example.com/base/direct/file.bin";

    await expect(
      signer.presign({
        method: "PUT",
        url,
      }),
    ).rejects.toThrow("Signer refused to sign URL with unexpected host");
  });

  it("rejects paths outside the allowed prefix", async () => {
    const signer = createS3Signer(baseConfig());
    const url = "https://uploads.s3.example.com/base/other/file.bin";

    await expect(
      signer.presign({
        method: "PUT",
        url,
      }),
    ).rejects.toThrow("Signer refused to sign URL outside allowed prefix");
  });

  it("rejects protocol mismatches", async () => {
    const signer = createS3Signer(baseConfig());
    const url = "http://uploads.s3.example.com/base/direct/file.bin";

    await expect(
      signer.presign({
        method: "PUT",
        url,
      }),
    ).rejects.toThrow("Signer refused to sign URL with unexpected protocol");
  });

  it("enforces path-style hosts and ports", async () => {
    const signer = createS3Signer({
      ...baseConfig(),
      endpoint: "https://minio.example.com:9000/base",
      pathStyle: true,
    });

    await expect(
      signer.presign({
        method: "PUT",
        url: "https://minio.example.com/base/uploads/direct/file.bin",
      }),
    ).rejects.toThrow("Signer refused to sign URL with unexpected port");

    const signed = await signer.presign({
      method: "PUT",
      url: "https://minio.example.com:9000/base/uploads/direct/file.bin",
    });

    expect(signed.url).toContain("minio.example.com:9000");
  });
});
