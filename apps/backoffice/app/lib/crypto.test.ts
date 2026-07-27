import { describe, expect, test, assert } from "vitest";

import { bytesToHex, sha256Hex } from "./crypto";

const TEXT_ENCODER = new TextEncoder();

describe("crypto utilities", () => {
  test("encodes bytes as lowercase hexadecimal", () => {
    assert(bytesToHex(new Uint8Array([0, 15, 16, 255])) === "000f10ff");
  });

  test("computes canonical SHA-256 vectors", async () => {
    await expect(sha256Hex(new Uint8Array())).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    await expect(sha256Hex(TEXT_ENCODER.encode("abc"))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("hashes only the addressed Uint8Array view", async () => {
    const padded = TEXT_ENCODER.encode("xabcx");

    await expect(sha256Hex(padded.subarray(1, 4))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
