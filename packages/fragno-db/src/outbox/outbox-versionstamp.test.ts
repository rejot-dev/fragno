import { describe, expect, it } from "vitest";

import { encodeVersionstamp, outboxPageAfterVersionstamp, versionstampToHex } from "./outbox";

function versionstamp(transactionVersion: bigint, userVersion = 0): string {
  return versionstampToHex(encodeVersionstamp(transactionVersion, userVersion));
}

describe("outbox page versionstamps", () => {
  it("returns the cursor immediately before the checkpoint page", () => {
    expect(outboxPageAfterVersionstamp(versionstamp(0n, 12))).toBeUndefined();
    expect(outboxPageAfterVersionstamp(versionstamp(499n, 12))).toBe(versionstamp(499n));
    expect(outboxPageAfterVersionstamp(versionstamp(500n, 12))).toBe(versionstamp(499n));
    expect(outboxPageAfterVersionstamp(versionstamp(999n, 12))).toBe(versionstamp(999n));
    expect(outboxPageAfterVersionstamp(versionstamp(1_000n, 12))).toBe(versionstamp(999n));
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
