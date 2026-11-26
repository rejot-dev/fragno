import type { AI_TELEMETRY_SCHEMA } from "@earendil-works/pi-ai/models";
import { tracing } from "cloudflare:workers";

import type { DURABLE_TELEMETRY_SCHEMA } from "@earendil-works/pi-durable";
import type {
  SpanAttributes,
  SpanOptions,
  SpanStatus,
  TelemetryContext,
  TelemetrySchemaSpanEndAttributes,
  TelemetrySchemaSpanStartAttributes,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry";

type CloudflareSpanAttributes = Record<string, boolean | number | string>;

function cloudflareSpanAttributes(attributes: SpanAttributes): CloudflareSpanAttributes {
  const result: CloudflareSpanAttributes = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined) {
      continue;
    }
    // Cloudflare spans hold scalars only; array attributes keep their values as JSON.
    result[name] = typeof value === "object" ? JSON.stringify(value) : value;
  }
  return result;
}

/** How one kind of pi span is recorded: its attribute names and the events it keeps. */
type PiSpanRecording = {
  startAttributes(attributes: SpanAttributes): SpanAttributes;
  endAttributes(attributes: SpanAttributes): SpanAttributes;
  /** Cloudflare has no span events, so an event survives only as attributes of its span. */
  eventAttributes(name: string, secondsSinceStart: number): SpanAttributes;
};

/**
 * A span this adapter does not know records its name and status only: a later pi may add
 * attributes, and only those named here are known to be free of content.
 */
const unknownSpanRecording: PiSpanRecording = {
  startAttributes: () => ({}),
  endAttributes: () => ({}),
  eventAttributes: () => ({}),
};

type SubmitStartAttributes = TelemetrySchemaSpanStartAttributes<
  typeof DURABLE_TELEMETRY_SCHEMA,
  "pi.durable.submit"
>;
type SubmitEndAttributes = TelemetrySchemaSpanEndAttributes<
  typeof DURABLE_TELEMETRY_SCHEMA,
  "pi.durable.submit"
>;
type PhaseStartAttributes = TelemetrySchemaSpanStartAttributes<
  typeof DURABLE_TELEMETRY_SCHEMA,
  "pi.durable.phase"
>;
type PhaseEndAttributes = TelemetrySchemaSpanEndAttributes<
  typeof DURABLE_TELEMETRY_SCHEMA,
  "pi.durable.phase"
>;

const submitSpanRecording: PiSpanRecording = {
  startAttributes(attributes) {
    const start = attributes as SubmitStartAttributes;
    return {
      "submission.type": start["submission.type"],
      "conversation.id": start["conversation.id"],
    };
  },
  endAttributes(attributes) {
    const end = attributes as SubmitEndAttributes;
    return { "submission.id": end["submission.id"], result: end.result };
  },
  eventAttributes: () => ({}),
};

const phaseSpanRecording: PiSpanRecording = {
  startAttributes(attributes) {
    const start = attributes as PhaseStartAttributes;
    return {
      "task.id": start["task.id"],
      "task.name": start["task.name"],
      phase: start.phase,
      kind: start.kind,
      attempt: start.attempt,
      resumed: start.resumed,
    };
  },
  endAttributes(attributes) {
    const end = attributes as PhaseEndAttributes;
    // Pi's `tool.name` and `tool.call_id` are left out: pi takes them from the model's answer
    // before it checks the tool was offered.
    return { outcome: end.outcome };
  },
  eventAttributes: () => ({}),
};

// `pi.ai.poll` shares `pi.ai.request`'s attributes.
type PiAiStartAttributes = TelemetrySchemaSpanStartAttributes<
  typeof AI_TELEMETRY_SCHEMA,
  "pi.ai.request"
>;
type PiAiEndAttributes = TelemetrySchemaSpanEndAttributes<
  typeof AI_TELEMETRY_SCHEMA,
  "pi.ai.request"
>;

/** Pi's provider IDs that differ from the GenAI conventions' provider names. */
const genAiProviderNames: Partial<Record<string, string>> = {
  // Pi's `google` provider calls generativelanguage.googleapis.com.
  google: "gcp.gemini",
};

/**
 * The conventions take provider-reported finish reasons; pi reports only its normalized stop
 * reason, so each maps to its closest conventional reason. A pending or deferred response has not
 * finished.
 */
const genAiFinishReasons: Record<NonNullable<PiAiEndAttributes["stop"]>, string | null> = {
  stop: "stop",
  length: "length",
  toolUse: "tool_call",
  error: "error",
  aborted: "interrupted",
  pending: null,
  deferred: null,
};

/** Records pi's model requests under the OpenTelemetry GenAI semantic conventions. */
const piAiSpanRecording: PiSpanRecording = {
  startAttributes(attributes) {
    const start = attributes as PiAiStartAttributes;
    return {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": genAiProviderNames[start.provider] ?? start.provider,
      "gen_ai.request.model": start.model,
      "gen_ai.request.reasoning.level": start.reasoning,
      "pi.ai.api": start.api,
    };
  },
  endAttributes(attributes) {
    const end = attributes as PiAiEndAttributes;
    const finishReason = end.stop === undefined ? null : genAiFinishReasons[end.stop];
    const cacheRead = end["usage.cache_read"] ?? 0;
    const cacheWrite = end["usage.cache_write"] ?? 0;
    return {
      "gen_ai.response.id": end["response.id"],
      "gen_ai.response.finish_reasons": finishReason === null ? undefined : [finishReason],
      // Pi counts input without cached tokens; the conventions' input total includes them.
      "gen_ai.usage.input_tokens":
        end["usage.input"] === undefined ? undefined : end["usage.input"] + cacheRead + cacheWrite,
      "gen_ai.usage.output_tokens": end["usage.output"],
      "gen_ai.usage.cache_read.input_tokens": end["usage.cache_read"],
      "gen_ai.usage.cache_write.input_tokens": end["usage.cache_write"],
      "pi.ai.stop": end.stop,
      "pi.ai.cost.total": end["cost.total"],
    };
  },
  eventAttributes(name, secondsSinceStart) {
    // Pi's first chunk is the stream's start, sent once the provider's response headers arrive and
    // before any output. `gen_ai.response.time_to_first_chunk` counts only output, so this keeps
    // pi's name.
    return name === "pi.ai.first_chunk"
      ? { "pi.ai.response.time_to_first_event": secondsSinceStart }
      : {};
  },
};

function recordingOf(spanName: string): PiSpanRecording {
  switch (spanName) {
    case "pi.ai.request":
    case "pi.ai.poll":
      return piAiSpanRecording;
    case "pi.durable.submit":
      return submitSpanRecording;
    case "pi.durable.phase":
      return phaseSpanRecording;
    default:
      return unknownSpanRecording;
  }
}

function setCloudflareSpanStatus(native: Span, status: SpanStatus): void {
  if (status.status === "ok") {
    native.setStatus({ code: "ok" });
    return;
  }
  // Pi's error messages carry a provider's response body or a task's error, which may hold what
  // people and tools wrote; the error's class is the name pi gives it.
  native.setStatus({ code: "error" });
  if (status.error) {
    native.setAttribute("error.type", status.error.name);
  }
}

/** Runs one pi span over a Cloudflare span, or over none when the runtime traces nothing. */
async function runPiSpan<T>(
  native: Span | null,
  options: SpanOptions,
  callback: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
  const recording = recordingOf(options.name);
  // Workers advance the clock only across I/O, which separates a request from its first event.
  const startedAt = performance.now();
  let settled = false;
  let statusSet = false;
  function record(attributes: SpanAttributes) {
    if (!settled) {
      native?.setAttributes(cloudflareSpanAttributes(attributes));
    }
  }
  const span: TelemetrySpan = {
    startSpan: startCloudflarePiSpan,
    // Cloudflare spans have no links.
    addLink() {},
    addEvent(name) {
      record(recording.eventAttributes(name, (performance.now() - startedAt) / 1000));
    },
    setAttributes(attributes) {
      record(recording.endAttributes(attributes));
    },
    setStatus(status) {
      if (settled) {
        return;
      }
      statusSet = true;
      if (native) {
        setCloudflareSpanStatus(native, status);
      }
    },
  };
  if (options.attributes) {
    record(recording.startAttributes(options.attributes));
  }
  try {
    const value = await callback(span);
    if (!statusSet) {
      native?.setStatus({ code: "ok" });
    }
    return value;
  } catch (error) {
    if (!statusSet && native) {
      // As for the statuses pi sets, a throw's message may carry content; only its type is recorded.
      native.setStatus({ code: "error" });
      native.setAttribute("error.type", error instanceof Error ? error.name : "UnknownError");
    }
    throw error;
  } finally {
    settled = true;
  }
}

/**
 * Cloudflare parents a span by the active async context, not by pi's explicit parent. Pi starts a
 * child inside its parent's callback, so both place it under the same span.
 */
async function startCloudflarePiSpan<T>(
  options: SpanOptions,
  callback: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
  let entered = false;
  try {
    const result = tracing.enterSpan(options.name, (native) => {
      entered = true;
      return runPiSpan(native, options, callback);
    });
    if (entered) {
      return await result;
    }
  } catch (error) {
    // `runPiSpan` turns every failure into a rejection, so a throw after entering is Cloudflare's
    // or the callback's, which must not run again without a span.
    if (entered) {
      throw error;
    }
  }
  // Pi requires its callback to run even where the runtime cannot create custom spans.
  return await runPiSpan(null, options, callback);
}

/**
 * Records pi's spans, such as `pi.ai.request` and `pi.durable.phase`, as Cloudflare custom spans.
 * Model requests carry the OpenTelemetry GenAI semantic conventions' attributes.
 */
export const cloudflarePiTelemetry: TelemetryContext = { startSpan: startCloudflarePiSpan };
