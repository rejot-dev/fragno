import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { createRouteCaller } from "@fragno-dev/core/api";

import {
  reson8PrerecordedTranscriptionSchema,
  type Reson8PrerecordedTranscription,
} from "@fragno-dev/reson8-fragment";

import type { BillingEventInput, BillingRecordEventResult } from "@/fragno/billing/contracts";
import type { Reson8Fragment } from "@/fragno/reson8";

import { isSuccessStatus, throwOnRouteRuntimeError } from "../runtime-errors";

export type Reson8Runtime = {
  transcribePrerecorded(args: {
    audio: ArrayBuffer | ArrayBufferView;
    query: Record<string, string>;
  }): Promise<Reson8PrerecordedTranscription>;
};

/** Transcribes under the platform key and bills each transcription to the paying organization. */
export function createReson8Runtime({
  reson8,
  scope,
  recordBillingEvent,
  nowEpochMs,
}: {
  reson8: Reson8Fragment;
  scope: BackofficeContextScope;
  /** Null when no organization pays for this caller's usage. */
  recordBillingEvent: ((event: BillingEventInput) => Promise<BillingRecordEventResult>) | null;
  nowEpochMs: () => number;
}): Reson8Runtime {
  // In-process, so the request carries no caller headers for the fragment to prefer over its key.
  const callRoute = createRouteCaller<Reson8Fragment>({
    baseUrl: "https://reson8.internal",
    mountRoute: "/api/reson8",
    fetch: (request) => reson8.handler(request),
  });

  return {
    async transcribePrerecorded({ audio, query }) {
      const response = await callRoute("POST", "/speech-to-text/prerecorded", {
        body: audio,
        query,
        headers: { "content-type": "application/octet-stream" },
      });
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        return throwOnRouteRuntimeError(response, {
          runtimeLabel: "Reson8",
          label: "reson8.prerecorded.transcribe",
        });
      }
      const transcription = reson8PrerecordedTranscriptionSchema.parse(response.data);
      await recordBillingEvent?.({
        id: `reson8-prerecorded:${crypto.randomUUID()}`,
        scope,
        source: "reson8",
        eventType: "prerecorded.transcribed",
        occurredAt: new Date(nowEpochMs()).toISOString(),
        measurements: [
          { meter: "transcription.requests", unit: "request", quantity: 1 },
          // Reson8 reports the duration it transcribed; requests are still counted without it.
          ...(transcription.duration_ms === undefined
            ? []
            : [
                {
                  meter: "transcription.audio",
                  unit: "millisecond",
                  quantity: Math.round(transcription.duration_ms),
                },
              ]),
        ],
      });
      return transcription;
    },
  };
}
