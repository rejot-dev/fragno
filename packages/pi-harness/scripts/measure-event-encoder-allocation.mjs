import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import inspector from "node:inspector";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

function parsePositiveInteger(value, option) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function parsePositiveNumber(value, option) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive number`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    worker: false,
    mode: undefined,
    workload: undefined,
    workloads: ["text", "tool-call"],
    size: undefined,
    sizes: [32_768, 65_536, 131_072],
    decoderSizes: [4_096, 8_192, 16_384],
    runs: 3,
    chunkBytes: 32,
    streams: 3,
    decoderStreams: 1,
    samplingInterval: 4_096,
    maxNormalizedGrowth: 1.25,
    maxNormalizedWireGrowth: 1.25,
    jsonPath: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    switch (argument) {
      case "--":
        break;
      case "--worker":
        options.worker = true;
        break;
      case "--mode":
        if (
          value !== "generate" &&
          value !== "encode" &&
          value !== "decode-baseline" &&
          value !== "decode" &&
          value !== "bytes"
        ) {
          throw new Error("--mode must be generate, encode, decode-baseline, decode, or bytes");
        }
        options.mode = value;
        index += 1;
        break;
      case "--workload":
        if (value !== "text" && value !== "tool-call") {
          throw new Error("--workload must be text or tool-call");
        }
        options.workload = value;
        index += 1;
        break;
      case "--workloads":
        options.workloads = value.split(",");
        if (options.workloads.some((workload) => workload !== "text" && workload !== "tool-call")) {
          throw new Error("--workloads must contain only text and tool-call");
        }
        index += 1;
        break;
      case "--size":
        options.size = parsePositiveInteger(value, argument);
        index += 1;
        break;
      case "--sizes":
        options.sizes = value.split(",").map((entry) => parsePositiveInteger(entry, argument));
        index += 1;
        break;
      case "--decoder-sizes":
        options.decoderSizes = value
          .split(",")
          .map((entry) => parsePositiveInteger(entry, argument));
        index += 1;
        break;
      case "--runs":
        options.runs = parsePositiveInteger(value, argument);
        index += 1;
        break;
      case "--chunk-bytes":
        options.chunkBytes = parsePositiveInteger(value, argument);
        index += 1;
        break;
      case "--streams":
        options.streams = parsePositiveInteger(value, argument);
        index += 1;
        break;
      case "--decoder-streams":
        options.decoderStreams = parsePositiveInteger(value, argument);
        index += 1;
        break;
      case "--sampling-interval":
        options.samplingInterval = parsePositiveInteger(value, argument);
        index += 1;
        break;
      case "--max-normalized-growth":
        options.maxNormalizedGrowth = parsePositiveNumber(value, argument);
        index += 1;
        break;
      case "--max-normalized-wire-growth":
        options.maxNormalizedWireGrowth = parsePositiveNumber(value, argument);
        index += 1;
        break;
      case "--json":
        options.jsonPath = value;
        index += 1;
        break;
      case "--help":
        console.log(`Usage: pnpm --filter @fragno-dev/pi-harness measure:event-encoder -- [options]

Options:
  --workloads <names>                 Comma-separated workloads: text,tool-call
  --sizes <bytes>                     Encoder payload sizes (default: 32768,65536,131072)
  --decoder-sizes <bytes>             Decoder payload sizes (default: 4096,8192,16384)
  --runs <count>                      Fresh processes per mode and size (default: 3)
  --chunk-bytes <bytes>               Streamed delta size (default: 32)
  --streams <count>                   Streams encoded in each allocation process (default: 3)
  --decoder-streams <count>           Streams decoded in each allocation process (default: 1)
  --sampling-interval <bytes>         V8 allocation sampling interval (default: 4096)
  --max-normalized-growth <n>         Maximum normalized allocation growth (default: 1.25)
  --max-normalized-wire-growth <n>    Maximum normalized encoded-byte growth (default: 1.25)
  --json <path>                       Write the complete report as JSON
`);
        process.exit(0);
        break;
      default:
        if (argument?.startsWith("--")) {
          throw new Error(`Unknown option: ${argument}`);
        }
    }
  }

  return options;
}

function createUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function createAssistantMessage(content, stopReason = "pending") {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "benchmark",
    model: "benchmark-model",
    usage: createUsage(),
    stopReason,
    timestamp: 1,
  };
}

function streamTextEvents(finalBytes, chunkBytes, consume) {
  const start = createAssistantMessage([]);
  consume({ type: "message_start", message: start });

  const partial = createAssistantMessage([{ type: "text", text: "" }]);
  consume({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
  });

  const chunk = "x".repeat(chunkBytes);
  let text = "";
  while (text.length < finalBytes) {
    const delta = chunk.slice(0, Math.min(chunk.length, finalBytes - text.length));
    text += delta;
    partial.content[0].text = text;
    consume({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
    });
  }

  consume({
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type: "text_end",
      contentIndex: 0,
      content: text,
      partial,
    },
  });
  const finalMessage = { ...partial, stopReason: "stop" };
  consume({ type: "message_end", message: finalMessage });
  return text.length;
}

function streamToolCallEvents(finalBytes, chunkBytes, consume) {
  consume({ type: "message_start", message: createAssistantMessage([]) });

  const partialToolCall = {
    type: "toolCall",
    id: "call-write-file",
    name: "write_file",
    arguments: {},
    partialJson: "",
  };
  const partial = createAssistantMessage([partialToolCall]);
  consume({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial },
  });

  const chunk = "x".repeat(chunkBytes);
  let code = "";
  while (code.length < finalBytes) {
    const codeDelta = chunk.slice(0, Math.min(chunk.length, finalBytes - code.length));
    const delta = code.length === 0 ? `{"code":"${codeDelta}` : codeDelta;
    code += codeDelta;
    partialToolCall.partialJson += delta;
    partialToolCall.arguments = { code };
    consume({
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta,
        partial,
      },
    });
  }

  partialToolCall.partialJson += '"}';
  consume({
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '"}',
      partial,
    },
  });

  const finalToolCall = {
    type: "toolCall",
    id: partialToolCall.id,
    name: partialToolCall.name,
    arguments: { code },
  };
  const finalMessage = createAssistantMessage([finalToolCall], "toolUse");
  consume({
    type: "message_update",
    message: finalMessage,
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: finalToolCall,
      partial: finalMessage,
    },
  });
  consume({ type: "message_end", message: finalMessage });
  return code.length;
}

function streamWorkloadEvents(workload, finalBytes, chunkBytes, consume) {
  switch (workload) {
    case "text":
      return streamTextEvents(finalBytes, chunkBytes, consume);
    case "tool-call":
      return streamToolCallEvents(finalBytes, chunkBytes, consume);
    default:
      throw new Error(`Unknown workload: ${workload}`);
  }
}

function summarizeAllocationProfile(profile) {
  const callFrames = new Map();
  const visit = (node) => {
    callFrames.set(node.id, node.callFrame);
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(profile.head);

  const allocations = new Map();
  let sampledAllocationBytes = 0;
  for (const sample of profile.samples ?? []) {
    sampledAllocationBytes += sample.size;
    const frame = callFrames.get(sample.nodeId) ?? {};
    const label = `${frame.functionName || "(anonymous)"} ${frame.url || ""}:${
      (frame.lineNumber ?? -1) + 1
    }`;
    allocations.set(label, (allocations.get(label) ?? 0) + sample.size);
  }

  return {
    sampledAllocationBytes,
    topCallFrames: [...allocations]
      .map(([callFrame, bytes]) => ({ callFrame, bytes }))
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 20),
  };
}

async function post(session, method, parameters = {}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    session.post(method, parameters, (error, result) => {
      if (error) {
        rejectPromise(new Error(`Inspector command failed: ${method}`, { cause: error }));
      } else {
        resolvePromise(result);
      }
    });
  });
}

async function runWorker(options) {
  if (!options.mode || !options.workload || !options.size) {
    throw new Error("Worker mode requires --mode, --workload, and --size");
  }
  if (typeof globalThis.gc !== "function") {
    throw new Error("Worker mode requires Node --expose-gc");
  }

  const { PiHarnessEventDecoder, PiHarnessEventEncoder } =
    await import("../dist/node/pi/harness/agent-harness-event-protocol.js");

  const encodeStreams = (finalBytes, streamCount) => {
    const streams = [];
    let checksum = 0;
    let eventCount = 0;
    for (let stream = 0; stream < streamCount; stream += 1) {
      const encoder = new PiHarnessEventEncoder();
      const events = [];
      checksum += streamWorkloadEvents(
        options.workload,
        finalBytes,
        options.chunkBytes,
        (event) => {
          const encoded = encoder.encode(event);
          events.push(encoded);
          checksum += encoded.event.type.length;
          eventCount += 1;
        },
      );
      streams.push(events);
    }
    return { streams, checksum, eventCount };
  };

  const runEncodeWorkload = (finalBytes, streamCount, encode, measureEncodedBytes) => {
    let checksum = 0;
    let encodedBytes = 0;
    let eventCount = 0;
    for (let stream = 0; stream < streamCount; stream += 1) {
      const encoder = encode ? new PiHarnessEventEncoder() : undefined;
      checksum += streamWorkloadEvents(
        options.workload,
        finalBytes,
        options.chunkBytes,
        (event) => {
          eventCount += 1;
          if (encoder) {
            const encoded = encoder.encode(event);
            checksum += encoded.event.type.length;
            if (measureEncodedBytes) {
              encodedBytes += Buffer.byteLength(JSON.stringify(encoded));
            }
          } else {
            checksum += event.type.length;
          }
        },
      );
    }
    return { checksum, encodedBytes, eventCount };
  };

  const runDecodeWorkload = (streams, decode) => {
    let checksum = 0;
    let eventCount = 0;
    for (const events of streams) {
      const decoder = decode ? new PiHarnessEventDecoder() : undefined;
      for (const encoded of events) {
        const event = decoder ? decoder.decode(encoded) : encoded.event;
        checksum += event.type.length;
        eventCount += 1;
      }
    }
    return { checksum, eventCount };
  };

  if (options.mode === "bytes") {
    const measured = runEncodeWorkload(options.size, 1, true, true);
    return {
      mode: options.mode,
      workload: options.workload,
      finalBytes: options.size,
      chunkBytes: options.chunkBytes,
      streamCount: 1,
      ...measured,
    };
  }

  let runMeasuredWorkload;
  if (options.mode === "decode-baseline" || options.mode === "decode") {
    const warmStreams = encodeStreams(Math.min(options.size, 4_096), 1).streams;
    runDecodeWorkload(warmStreams, options.mode === "decode");
    const measuredStreams = encodeStreams(options.size, options.streams).streams;
    runMeasuredWorkload = () => runDecodeWorkload(measuredStreams, options.mode === "decode");
  } else {
    runEncodeWorkload(Math.min(options.size, 4_096), 1, options.mode === "encode", false);
    runMeasuredWorkload = () =>
      runEncodeWorkload(options.size, options.streams, options.mode === "encode", false);
  }

  globalThis.gc();
  globalThis.gc();

  const session = new inspector.Session();
  session.connect();
  await post(session, "HeapProfiler.startSampling", {
    samplingInterval: options.samplingInterval,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const startedAt = performance.now();
  const measured = runMeasuredWorkload();
  const durationMs = performance.now() - startedAt;
  const { profile } = await post(session, "HeapProfiler.stopSampling");
  session.disconnect();

  return {
    mode: options.mode,
    workload: options.workload,
    finalBytes: options.size,
    chunkBytes: options.chunkBytes,
    streamCount: options.streams,
    durationMs,
    ...measured,
    ...summarizeAllocationProfile(profile),
  };
}

function runFreshWorker(options, mode, workload, size, streamCount = options.streams) {
  const result = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      scriptPath,
      "--worker",
      "--mode",
      mode,
      "--workload",
      workload,
      "--size",
      String(size),
      "--chunk-bytes",
      String(options.chunkBytes),
      "--streams",
      String(streamCount),
      "--sampling-interval",
      String(options.samplingInterval),
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Benchmark worker exited ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function formatBytes(bytes) {
  if (bytes < 1_024) {
    return `${bytes} B`;
  }
  if (bytes < 1_048_576) {
    return `${(bytes / 1_024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1_048_576).toFixed(2)} MiB`;
}

async function runParent(options) {
  const workloads = [];

  for (const workload of options.workloads) {
    const encoderCases = [];
    let previousEncoderOverhead;
    let previousEncodedBytes;
    let previousEncoderSize;

    for (const size of options.sizes) {
      const generateRuns = [];
      const encodeRuns = [];
      for (let run = 0; run < options.runs; run += 1) {
        generateRuns.push(runFreshWorker(options, "generate", workload, size));
        encodeRuns.push(runFreshWorker(options, "encode", workload, size));
      }
      const byteRun = runFreshWorker(options, "bytes", workload, size);

      const generateMedianBytes = median(
        generateRuns.map((result) => result.sampledAllocationBytes),
      );
      const encodeMedianBytes = median(encodeRuns.map((result) => result.sampledAllocationBytes));
      const encoderOverheadBytes = Math.max(0, encodeMedianBytes - generateMedianBytes);
      const encoderOverheadGrowth =
        previousEncoderOverhead === undefined || previousEncoderOverhead === 0
          ? undefined
          : encoderOverheadBytes / previousEncoderOverhead;
      const encodedByteGrowth =
        previousEncodedBytes === undefined || previousEncodedBytes === 0
          ? undefined
          : byteRun.encodedBytes / previousEncodedBytes;
      const inputGrowth =
        previousEncoderSize === undefined ? undefined : size / previousEncoderSize;
      const normalizedEncoderGrowth =
        encoderOverheadGrowth === undefined || inputGrowth === undefined
          ? undefined
          : encoderOverheadGrowth / inputGrowth;
      const normalizedEncodedByteGrowth =
        encodedByteGrowth === undefined || inputGrowth === undefined
          ? undefined
          : encodedByteGrowth / inputGrowth;
      previousEncoderOverhead = encoderOverheadBytes;
      previousEncodedBytes = byteRun.encodedBytes;
      previousEncoderSize = size;

      encoderCases.push({
        finalBytes: size,
        eventCount: byteRun.eventCount,
        encodedBytes: byteRun.encodedBytes,
        generateMedianBytes,
        encodeMedianBytes,
        encoderOverheadBytes,
        encoderOverheadGrowth,
        encodedByteGrowth,
        inputGrowth,
        normalizedEncoderGrowth,
        normalizedEncodedByteGrowth,
        generateRuns,
        encodeRuns,
      });
    }

    const decoderCases = [];
    let previousDecoderOverhead;
    let previousDecoderSize;

    for (const size of options.decoderSizes) {
      const decodeBaselineRuns = [];
      const decodeRuns = [];
      for (let run = 0; run < options.runs; run += 1) {
        decodeBaselineRuns.push(
          runFreshWorker(options, "decode-baseline", workload, size, options.decoderStreams),
        );
        decodeRuns.push(runFreshWorker(options, "decode", workload, size, options.decoderStreams));
      }

      const decodeBaselineMedianBytes = median(
        decodeBaselineRuns.map((result) => result.sampledAllocationBytes),
      );
      const decodeMedianBytes = median(decodeRuns.map((result) => result.sampledAllocationBytes));
      const decoderOverheadBytes = Math.max(0, decodeMedianBytes - decodeBaselineMedianBytes);
      const decoderOverheadGrowth =
        previousDecoderOverhead === undefined || previousDecoderOverhead === 0
          ? undefined
          : decoderOverheadBytes / previousDecoderOverhead;
      const inputGrowth =
        previousDecoderSize === undefined ? undefined : size / previousDecoderSize;
      const normalizedDecoderGrowth =
        decoderOverheadGrowth === undefined || inputGrowth === undefined
          ? undefined
          : decoderOverheadGrowth / inputGrowth;
      previousDecoderOverhead = decoderOverheadBytes;
      previousDecoderSize = size;

      decoderCases.push({
        finalBytes: size,
        eventCount: decodeRuns[0].eventCount,
        decodeBaselineMedianBytes,
        decodeMedianBytes,
        decoderOverheadBytes,
        decoderOverheadGrowth,
        inputGrowth,
        normalizedDecoderGrowth,
        decodeBaselineRuns,
        decodeRuns,
      });
    }

    workloads.push({ workload, encoderCases, decoderCases });
  }

  const report = {
    measuredAt: new Date().toISOString(),
    options: {
      workloads: options.workloads,
      sizes: options.sizes,
      decoderSizes: options.decoderSizes,
      runs: options.runs,
      chunkBytes: options.chunkBytes,
      streams: options.streams,
      decoderStreams: options.decoderStreams,
      samplingInterval: options.samplingInterval,
      maxNormalizedGrowth: options.maxNormalizedGrowth,
      maxNormalizedWireGrowth: options.maxNormalizedWireGrowth,
    },
    workloads,
  };

  console.log("\nPi event protocol allocation and wire-size benchmark\n");
  for (const workload of workloads) {
    console.log(`${workload.workload} encoder:`);
    for (const benchmarkCase of workload.encoderCases) {
      console.log(
        `  final=${formatBytes(benchmarkCase.finalBytes)} ` +
          `events=${benchmarkCase.eventCount} ` +
          `wire=${formatBytes(benchmarkCase.encodedBytes)} ` +
          `generate=${formatBytes(benchmarkCase.generateMedianBytes)} ` +
          `encoded=${formatBytes(benchmarkCase.encodeMedianBytes)} ` +
          `encoder-overhead=${formatBytes(benchmarkCase.encoderOverheadBytes)}` +
          (benchmarkCase.encoderOverheadGrowth === undefined
            ? ""
            : ` allocation-growth=${benchmarkCase.encoderOverheadGrowth.toFixed(2)}x` +
              ` normalized=${benchmarkCase.normalizedEncoderGrowth.toFixed(2)}x`) +
          (benchmarkCase.encodedByteGrowth === undefined
            ? ""
            : ` wire-growth=${benchmarkCase.encodedByteGrowth.toFixed(2)}x` +
              ` normalized=${benchmarkCase.normalizedEncodedByteGrowth.toFixed(2)}x`),
      );
    }

    console.log(`${workload.workload} decoder:`);
    for (const benchmarkCase of workload.decoderCases) {
      console.log(
        `  final=${formatBytes(benchmarkCase.finalBytes)} ` +
          `events=${benchmarkCase.eventCount} ` +
          `baseline=${formatBytes(benchmarkCase.decodeBaselineMedianBytes)} ` +
          `decoded=${formatBytes(benchmarkCase.decodeMedianBytes)} ` +
          `decoder-overhead=${formatBytes(benchmarkCase.decoderOverheadBytes)}` +
          (benchmarkCase.decoderOverheadGrowth === undefined
            ? ""
            : ` allocation-growth=${benchmarkCase.decoderOverheadGrowth.toFixed(2)}x` +
              ` normalized=${benchmarkCase.normalizedDecoderGrowth.toFixed(2)}x`),
      );
    }
    console.log();
  }

  if (options.jsonPath) {
    const outputPath = resolve(options.jsonPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Wrote ${outputPath}`);
  }

  const encoderAllocationRegressions = workloads.flatMap(({ workload, encoderCases }) =>
    encoderCases
      .filter(
        (benchmarkCase) =>
          benchmarkCase.normalizedEncoderGrowth !== undefined &&
          benchmarkCase.normalizedEncoderGrowth > options.maxNormalizedGrowth,
      )
      .map((benchmarkCase) => ({ workload, benchmarkCase })),
  );
  const decoderAllocationRegressions = workloads.flatMap(({ workload, decoderCases }) =>
    decoderCases
      .filter(
        (benchmarkCase) =>
          benchmarkCase.normalizedDecoderGrowth !== undefined &&
          benchmarkCase.normalizedDecoderGrowth > options.maxNormalizedGrowth,
      )
      .map((benchmarkCase) => ({ workload, benchmarkCase })),
  );
  const wireRegressions = workloads.flatMap(({ workload, encoderCases }) =>
    encoderCases
      .filter(
        (benchmarkCase) =>
          benchmarkCase.normalizedEncodedByteGrowth !== undefined &&
          benchmarkCase.normalizedEncodedByteGrowth > options.maxNormalizedWireGrowth,
      )
      .map((benchmarkCase) => ({ workload, benchmarkCase })),
  );
  if (
    encoderAllocationRegressions.length > 0 ||
    decoderAllocationRegressions.length > 0 ||
    wireRegressions.length > 0
  ) {
    throw new Error(
      `Event protocol growth exceeded its normalized limit: allocation=${options.maxNormalizedGrowth.toFixed(2)}x wire=${options.maxNormalizedWireGrowth.toFixed(2)}x`,
    );
  }
}

const options = parseArguments(process.argv.slice(2));
if (options.worker) {
  const result = await runWorker(options);
  process.stdout.write(JSON.stringify(result));
} else {
  await runParent(options);
}
