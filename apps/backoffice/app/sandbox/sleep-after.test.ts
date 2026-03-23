import { describe, expect, test } from "vitest";

import { parseSleepAfterInput } from "./sleep-after";

describe("parseSleepAfterInput", () => {
  test("accepts empty values as undefined", () => {
    expect(parseSleepAfterInput(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseSleepAfterInput("")).toEqual({ ok: true, value: undefined });
    expect(parseSleepAfterInput("   ")).toEqual({ ok: true, value: undefined });
  });

  test("accepts numeric seconds as number", () => {
    expect(parseSleepAfterInput(300)).toEqual({ ok: true, value: 300 });
    expect(parseSleepAfterInput("300")).toEqual({ ok: true, value: 300 });
  });

  test("accepts duration values and normalizes unit casing", () => {
    expect(parseSleepAfterInput("15m")).toEqual({ ok: true, value: "15m" });
    expect(parseSleepAfterInput("15M")).toEqual({ ok: true, value: "15m" });
  });

  test("rejects invalid text values", () => {
    const parsed = parseSleepAfterInput("adsfafds");

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      throw new Error("Expected invalid parse result");
    }
    expect(parsed.message).toContain('Invalid "sleep after" value');
  });

  test("rejects invalid numeric values", () => {
    expect(parseSleepAfterInput(Number.NaN)).toEqual({
      ok: false,
      message:
        'Invalid "sleep after" value. Use seconds (for example `300`) or a duration like `30s`, `5m`, or `1h`.',
    });
    expect(parseSleepAfterInput(1.5)).toEqual({
      ok: false,
      message:
        'Invalid "sleep after" value. Use seconds (for example `300`) or a duration like `30s`, `5m`, or `1h`.',
    });
    expect(parseSleepAfterInput(Number.POSITIVE_INFINITY)).toEqual({
      ok: false,
      message:
        'Invalid "sleep after" value. Use seconds (for example `300`) or a duration like `30s`, `5m`, or `1h`.',
    });
    expect(parseSleepAfterInput(-1)).toEqual({
      ok: false,
      message:
        'Invalid "sleep after" value. Use seconds (for example `300`) or a duration like `30s`, `5m`, or `1h`.',
    });
  });

  test("rejects overflowed numeric strings and durations", () => {
    expect(parseSleepAfterInput("9".repeat(10_000))).toEqual({
      ok: false,
      message:
        'Invalid "sleep after" value. Use seconds (for example `300`) or a duration like `30s`, `5m`, or `1h`.',
    });
    expect(parseSleepAfterInput(`${"9".repeat(10_000)}s`)).toEqual({
      ok: false,
      message:
        'Invalid "sleep after" value. Use seconds (for example `300`) or a duration like `30s`, `5m`, or `1h`.',
    });
  });
});
