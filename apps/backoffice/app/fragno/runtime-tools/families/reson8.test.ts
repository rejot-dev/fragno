import { describe, expect, test, vi, assert } from "vitest";

import type { BackofficeToolContext } from "../runtime-tools";
import { reson8RuntimeTools, type Reson8Runtime } from "./reson8";

const createRuntime = (): Reson8Runtime =>
  ({
    transcribePrerecorded: vi.fn(async () => ({ text: "hello world" })),
  }) as unknown as Reson8Runtime;

describe("reson8 runtime tools", () => {
  test("defines camelCase codemode name and legacy bash command", () => {
    const [transcribe] = reson8RuntimeTools;

    assert(transcribe.name === "transcribePrerecorded");
    assert(transcribe.adapters?.bash?.command === "reson8.prerecorded.transcribe");
  });

  test("parse and validate transcribe input", () => {
    const [transcribe] = reson8RuntimeTools;

    expect(
      transcribe.adapters!.bash!.parse([
        "--input",
        "./audio.raw",
        "--encoding",
        "pcm_s16le",
        "--sample-rate",
        "16000",
        "--channels",
        "1",
        "--include-words",
      ]),
    ).toEqual({
      inputPath: "./audio.raw",
      encoding: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
      includeWords: true,
    });
  });

  test("invokes semantic runtime for codemode when audio is provided", async () => {
    const runtime = createRuntime();
    const context: BackofficeToolContext<{ reson8: Reson8Runtime }> = {
      runtimes: { reson8: runtime },
    };
    const audio = new Uint8Array([1, 2, 3]);

    await expect(
      reson8RuntimeTools[0].execute({ audio, includeConfidence: true }, context),
    ).resolves.toEqual({
      text: "hello world",
    });
    expect(runtime.transcribePrerecorded).toHaveBeenCalledWith({
      audio,
      query: { include_confidence: "true" },
    });
  });

  test("normalizes JSON byte arrays from codemode before calling Reson8", async () => {
    const runtime = createRuntime();
    const context: BackofficeToolContext<{ reson8: Reson8Runtime }> = {
      runtimes: { reson8: runtime },
    };

    await reson8RuntimeTools[0].execute({ audio: [1, 2, 3] }, context);

    expect(runtime.transcribePrerecorded).toHaveBeenCalledWith({
      audio: new Uint8Array([1, 2, 3]),
      query: {},
    });
  });
});
