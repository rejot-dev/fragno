import { describe, expect, it } from "vitest";

import {
  encodeVersionstamp,
  FRAGNO_OUTBOX_PAGE_SIZE,
  outboxPageAfterVersionstamp,
  versionstampToHex,
} from "./outbox";

function versionstamp(transactionVersion: bigint, userVersion = 0): string {
  return versionstampToHex(encodeVersionstamp(transactionVersion, userVersion));
}

describe("outbox page versionstamps", () => {
  it("returns the cursor immediately before the checkpoint page", () => {
    expect(outboxPageAfterVersionstamp(versionstamp(0n, 12))).toBeUndefined();
    const pageSize = BigInt(FRAGNO_OUTBOX_PAGE_SIZE);
    expect(outboxPageAfterVersionstamp(versionstamp(pageSize - 1n, 12))).toBe(
      versionstamp(pageSize - 1n),
    );
    expect(outboxPageAfterVersionstamp(versionstamp(pageSize, 12))).toBe(
      versionstamp(pageSize - 1n),
    );
    expect(outboxPageAfterVersionstamp(versionstamp(pageSize * 2n - 1n, 12))).toBe(
      versionstamp(pageSize * 2n - 1n),
    );
    expect(outboxPageAfterVersionstamp(versionstamp(pageSize * 2n, 12))).toBe(
      versionstamp(pageSize * 2n - 1n),
    );
  });

  it("rejects malformed versionstamps", () => {
    expect(() => outboxPageAfterVersionstamp("z".repeat(24))).toThrow(
      "Invalid hexadecimal outbox versionstamp.",
    );
    expect(() => outboxPageAfterVersionstamp("00")).toThrow(
      "Invalid outbox versionstamp byte length: 1",
    );
  });
});
