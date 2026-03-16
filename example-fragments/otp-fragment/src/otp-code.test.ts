import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ALPHABET,
  DEFAULT_CODE_LENGTH,
  MAX_CODE_ALPHABET_LENGTH,
  generateOtpCode,
  normalizeOtpCode,
  resolveCodeAlphabet,
  resolveCodeLength,
  validateOtpCodeConfig,
} from "./otp-code";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("otp code helpers", () => {
  it("resolves the default alphabet and rejects alphabets longer than 256 characters", () => {
    expect(resolveCodeAlphabet({})).toBe(DEFAULT_ALPHABET);

    const longAlphabet = Array.from({ length: MAX_CODE_ALPHABET_LENGTH + 1 }, (_, index) =>
      String.fromCharCode(0xe000 + index),
    ).join("");

    expect(() => resolveCodeAlphabet({ alphabet: longAlphabet })).toThrow(
      `OTP alphabet length must not exceed ${MAX_CODE_ALPHABET_LENGTH} characters.`,
    );
  });

  it("resolves code length with sane defaults", () => {
    expect(resolveCodeLength({})).toBe(DEFAULT_CODE_LENGTH);
    expect(resolveCodeLength({ codeLength: 6 })).toBe(6);
    expect(resolveCodeLength({ codeLength: 0 })).toBe(DEFAULT_CODE_LENGTH);
    expect(resolveCodeLength({ codeLength: -1 })).toBe(DEFAULT_CODE_LENGTH);
    expect(resolveCodeLength({ codeLength: 1.5 })).toBe(DEFAULT_CODE_LENGTH);
  });

  it("validates explicit OTP code config", () => {
    expect(() => validateOtpCodeConfig({})).not.toThrow();
    expect(() => validateOtpCodeConfig({ alphabet: "abcdef", codeLength: 6 })).not.toThrow();
    expect(() => validateOtpCodeConfig({ alphabet: "" })).toThrow(
      "OTP alphabet must not be empty.",
    );
    expect(() => validateOtpCodeConfig({ codeLength: 0 })).toThrow(
      "OTP codeLength must be a positive integer.",
    );
    expect(() => validateOtpCodeConfig({ codeLength: 1.5 })).toThrow(
      "OTP codeLength must be a positive integer.",
    );
  });

  it("normalizes OTP input based on alphabet casing", () => {
    expect(normalizeOtpCode(" abc123 ", {})).toBe("ABC123");
    expect(normalizeOtpCode(" abc123 ", { alphabet: "abcdef123" })).toBe("abc123");
  });

  it("uses rejection sampling to avoid modulo bias", () => {
    const originalGetRandomValues = crypto.getRandomValues.bind(crypto);
    let randomCallCount = 0;

    vi.spyOn(crypto, "getRandomValues").mockImplementation(((values: Uint8Array) => {
      if (values.length !== 1) {
        return originalGetRandomValues(values as Parameters<typeof crypto.getRandomValues>[0]);
      }

      values[0] = randomCallCount === 0 ? 250 : 5;
      randomCallCount += 1;
      return values;
    }) as typeof crypto.getRandomValues);

    expect(generateOtpCode({ alphabet: "0123456789", codeLength: 1 })).toBe("5");
    expect(randomCallCount).toBe(2);
  });

  it("generates codes with the requested alphabet and length", () => {
    vi.spyOn(crypto, "getRandomValues").mockImplementation(((values: Uint8Array) => {
      values.set([0, 1, 2, 3].slice(0, values.length));
      return values;
    }) as typeof crypto.getRandomValues);

    expect(generateOtpCode({ alphabet: "abcd", codeLength: 4 })).toBe("abcd");
  });
});
