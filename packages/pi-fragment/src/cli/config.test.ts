import { describe, expect, it, assert } from "vitest";

import {
  DEFAULT_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  parseEnvHeaders,
  parseFlagHeaders,
  resolveConfig,
} from "./config";

describe("cli config", () => {
  it("uses defaults when no values are provided", () => {
    const config = resolveConfig({ env: {} });

    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(config.retries).toBe(DEFAULT_RETRIES);
    expect(config.retryDelayMs).toBe(DEFAULT_RETRY_DELAY_MS);
    expect(config.headers).toEqual({});
  });

  it("applies env vars when flags are missing", () => {
    const config = resolveConfig({
      env: {
        FRAGNO_PI_BASE_URL: "https://example.com/api",
        FRAGNO_PI_TIMEOUT_MS: "12000",
        FRAGNO_PI_RETRIES: "4",
        FRAGNO_PI_RETRY_DELAY_MS: "250",
        FRAGNO_PI_HEADERS: "Authorization: Bearer abc; X-Test: value",
      },
    });

    assert(config.baseUrl === "https://example.com/api");
    assert(config.timeoutMs === 12000);
    assert(config.retries === 4);
    assert(config.retryDelayMs === 250);
    expect(config.headers).toEqual({
      Authorization: "Bearer abc",
      "X-Test": "value",
    });
  });

  it("prefers flags over env vars", () => {
    const config = resolveConfig({
      baseUrl: "https://flags.example.com",
      timeoutMs: "3000",
      retries: 1,
      retryDelayMs: 100,
      headers: ["Authorization: Bearer flag"],
      env: {
        FRAGNO_PI_BASE_URL: "https://env.example.com",
        FRAGNO_PI_TIMEOUT_MS: "9000",
        FRAGNO_PI_RETRIES: "5",
        FRAGNO_PI_RETRY_DELAY_MS: "600",
        FRAGNO_PI_HEADERS: "Authorization: Bearer env; X-Test: env",
      },
    });

    assert(config.baseUrl === "https://flags.example.com");
    assert(config.timeoutMs === 3000);
    assert(config.retries === 1);
    assert(config.retryDelayMs === 100);
    expect(config.headers).toEqual({
      Authorization: "Bearer flag",
      "X-Test": "env",
    });
  });

  it("rejects invalid header entries", () => {
    expect(() => parseEnvHeaders("invalid")).toThrow("Key: Value");
    expect(() => parseFlagHeaders(["MissingValue:"])).toThrow("key and value");
  });

  it("rejects non-numeric or negative values", () => {
    expect(() => resolveConfig({ timeoutMs: "abc", env: {} })).toThrow("timeout must be a number");
    expect(() => resolveConfig({ retries: "-1", env: {} })).toThrow("retries must be at least 0");
    expect(() => resolveConfig({ retryDelayMs: -5, env: {} })).toThrow(
      "retry delay must be at least 0",
    );
    expect(() => resolveConfig({ timeoutMs: 0, env: {} })).toThrow("timeout must be at least 1");
  });
});
