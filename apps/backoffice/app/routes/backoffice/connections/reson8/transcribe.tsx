import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useOutletContext,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import type { Reson8RealtimeOriginDiagnostic } from "workers/reson8.do";

import type {
  Reson8CustomModel,
  Reson8PrerecordedTranscription,
} from "@fragno-dev/reson8-fragment";

import { FormContainer, FormField } from "@/components/backoffice";
import { createReson8Client } from "@/fragno/reson8-client";

import {
  fetchReson8Config,
  fetchReson8CustomModels,
  fetchReson8RealtimeOriginDiagnostic,
  transcribeReson8Prerecorded,
} from "./data";
import { type Reson8LayoutContext } from "./shared";

type TranscribeActionData =
  | {
      ok: true;
      resultId: string;
      fileName: string;
      transcription: Reson8PrerecordedTranscription;
    }
  | {
      ok: false;
      message: string;
    };

type PrerecordedFormState = {
  fileName: string;
  customModelId: string;
  includeTimestamps: boolean;
};

type ConversationEntry = {
  id: string;
  source: "prerecorded" | "realtime";
  title?: string;
  text: string;
  createdAt: string;
};

type RealtimeRecordingDownload = {
  url: string;
  fileName: string;
};

const DEFAULT_PRERECORDED_FORM_STATE: PrerecordedFormState = {
  fileName: "",
  customModelId: "",
  includeTimestamps: true,
};

const createConversationEntryId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `conversation-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const getErrorMessage = (value: unknown) => {
  if (!value) {
    return null;
  }

  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === "object" && value !== null && "message" in value) {
    const message = (value as { message?: unknown }).message;
    return typeof message === "string" ? message : null;
  }

  return typeof value === "string" ? value : null;
};

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const orgId = params.orgId;
  if (!orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const { configState, configError } = await fetchReson8Config(context, orgId);
  if (configError) {
    return {
      configError,
      modelsError: null,
      models: [],
      realtimeOriginDiagnostic: null,
      realtimeOriginDiagnosticError: null,
    };
  }

  if (!configState?.configured) {
    return redirect(`/backoffice/connections/reson8/${orgId}/configuration`);
  }

  const { models, modelsError } = await fetchReson8CustomModels(request, context, orgId);
  const currentOrigin = new URL(request.url).origin;
  const { diagnostic, diagnosticError } = await fetchReson8RealtimeOriginDiagnostic(
    context,
    orgId,
    currentOrigin,
  );

  return {
    configError: null,
    modelsError,
    models,
    realtimeOriginDiagnostic: diagnostic,
    realtimeOriginDiagnosticError: diagnosticError,
  };
}

export async function action({ request, context, params }: ActionFunctionArgs) {
  const orgId = params.orgId;
  if (!orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const audioFile = formData.get("audioFile");
  if (!(audioFile instanceof File) || audioFile.size === 0) {
    return {
      ok: false,
      message: "Choose an audio file before submitting.",
    } satisfies TranscribeActionData;
  }

  const customModelId =
    typeof formData.get("customModelId") === "string"
      ? String(formData.get("customModelId")).trim()
      : "";
  const query: Record<string, string> = {
    include_timestamps: formData.get("includeTimestamps") === "on" ? "true" : "false",
    include_words: "false",
    include_confidence: "false",
  };

  if (customModelId) {
    query.custom_model_id = customModelId;
  }

  const result = await transcribeReson8Prerecorded(request, context, orgId, {
    body: await audioFile.arrayBuffer(),
    query,
  });

  if (result.error || !result.transcription) {
    return {
      ok: false,
      message: result.error ?? "Reson8 did not return a transcription.",
    } satisfies TranscribeActionData;
  }

  return {
    ok: true,
    resultId: createConversationEntryId(),
    fileName: audioFile.name,
    transcription: result.transcription,
  } satisfies TranscribeActionData;
}

function RealtimeSpeechSection({
  orgId,
  models,
  realtimeOriginDiagnostic,
  realtimeOriginDiagnosticError,
  onAppendEntries,
  onInterimTranscriptChange,
  onRecordedAudioChange,
  clearConversationVersion,
}: {
  orgId: string;
  models: Reson8CustomModel[];
  realtimeOriginDiagnostic: Reson8RealtimeOriginDiagnostic | null;
  realtimeOriginDiagnosticError: string | null;
  onAppendEntries: (entries: ConversationEntry[]) => void;
  onInterimTranscriptChange: (value: string | null) => void;
  onRecordedAudioChange: (value: RealtimeRecordingDownload | null) => void;
  clearConversationVersion: number;
}) {
  const [realtimeModelId, setRealtimeModelId] = useState("");
  const [realtimeControlError, setRealtimeControlError] = useState<string | null>(null);
  const processedRealtimeSegmentsRef = useRef(0);

  const reson8 = useMemo(() => createReson8Client(orgId), [orgId]);
  const realtime = reson8.useRealtimeTranscriber({
    query: {
      include_interim: true,
      include_timestamps: true,
      ...(realtimeModelId ? { custom_model_id: realtimeModelId } : {}),
    },
    recordAudio: true,
  });
  const realtimeInterimText =
    typeof realtime.interimTranscript === "string" ? realtime.interimTranscript : null;
  const realtimeRecordedAudioDownloadUrl =
    typeof realtime.recordedAudioDownloadUrl === "string"
      ? realtime.recordedAudioDownloadUrl
      : null;
  const realtimeRecordedAudioFileName =
    typeof realtime.recordedAudioFileName === "string" ? realtime.recordedAudioFileName : null;

  useEffect(() => {
    onInterimTranscriptChange(realtimeInterimText);
  }, [onInterimTranscriptChange, realtimeInterimText]);

  useEffect(() => {
    if (!realtimeRecordedAudioDownloadUrl || !realtimeRecordedAudioFileName) {
      onRecordedAudioChange(null);
      return;
    }

    onRecordedAudioChange({
      url: realtimeRecordedAudioDownloadUrl,
      fileName: realtimeRecordedAudioFileName,
    });
  }, [onRecordedAudioChange, realtimeRecordedAudioDownloadUrl, realtimeRecordedAudioFileName]);

  useEffect(() => {
    if (realtime.finalTranscripts.length < processedRealtimeSegmentsRef.current) {
      processedRealtimeSegmentsRef.current = 0;
    }

    const nextTranscripts = realtime.finalTranscripts.slice(processedRealtimeSegmentsRef.current);
    if (nextTranscripts.length === 0) {
      return;
    }

    onAppendEntries(
      nextTranscripts.map((transcript) => ({
        id: createConversationEntryId(),
        source: "realtime" as const,
        text: transcript.text,
        createdAt: new Date().toISOString(),
      })),
    );

    processedRealtimeSegmentsRef.current = realtime.finalTranscripts.length;
  }, [onAppendEntries, realtime.finalTranscripts]);

  useEffect(() => {
    if (realtime.flushConfirmations.length === 0) {
      return;
    }

    onInterimTranscriptChange(null);
  }, [onInterimTranscriptChange, realtime.flushConfirmations.length]);

  useEffect(
    () => () => {
      onInterimTranscriptChange(null);
      onRecordedAudioChange(null);
    },
    [onInterimTranscriptChange, onRecordedAudioChange],
  );

  const startRealtime = async () => {
    setRealtimeControlError(null);
    try {
      await realtime.start();
    } catch (error) {
      setRealtimeControlError(
        error instanceof Error ? error.message : "Failed to start realtime transcription.",
      );
    }
  };

  const stopRealtime = async () => {
    setRealtimeControlError(null);
    try {
      await realtime.stop();
    } catch (error) {
      setRealtimeControlError(
        error instanceof Error ? error.message : "Failed to stop realtime transcription.",
      );
    }
  };

  useEffect(() => {
    processedRealtimeSegmentsRef.current = realtime.finalTranscripts.length;
    realtime.clearRecordedAudio();
    onInterimTranscriptChange(null);
    onRecordedAudioChange(null);
  }, [clearConversationVersion, onInterimTranscriptChange, onRecordedAudioChange]);

  const realtimeMicrophoneError = getErrorMessage(realtime.microphoneError);
  const realtimeLatestError = getErrorMessage(realtime.errors[0]);
  const hasOriginRejectionDiagnostic =
    realtimeOriginDiagnostic !== null && !realtimeOriginDiagnostic.websocketAccepted;

  return (
    <FormContainer
      title="Realtime speech"
      eyebrow="Live microphone"
      description="Capture microphone audio in the browser, stream it to Reson8, and append final segments to the same conversation."
    >
      <FormField label="Realtime custom model" hint="Optional vocabulary boost for live speech.">
        <select
          value={realtimeModelId}
          disabled={realtime.started}
          onChange={(event) => setRealtimeModelId(event.target.value)}
          className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none disabled:opacity-60"
        >
          <option value="">No custom model</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </FormField>

      {realtimeOriginDiagnostic && !realtimeOriginDiagnostic.websocketAccepted ? (
        <div className="border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
          <p className="text-[10px] font-semibold tracking-[0.22em] uppercase">
            Realtime origin diagnostic
          </p>
          <p className="mt-2 font-medium">{realtimeOriginDiagnostic.message}</p>
          <div className="mt-2 grid gap-2 text-xs text-current/80 md:grid-cols-3">
            <p>
              <span className="font-semibold text-current">Origin:</span>{" "}
              {realtimeOriginDiagnostic.origin}
            </p>
            <p>
              <span className="font-semibold text-current">Token status:</span>{" "}
              {realtimeOriginDiagnostic.tokenStatus ?? "Unavailable"}
            </p>
            <p>
              <span className="font-semibold text-current">Handshake status:</span>{" "}
              {realtimeOriginDiagnostic.websocketStatus ?? "Unavailable"}
            </p>
          </div>
          <p className="mt-2 text-xs text-current/80">
            Reson8 rejected the websocket handshake for this origin. Your current origin may need to
            be allowlisted by Reson8.
          </p>
        </div>
      ) : null}

      {realtimeOriginDiagnosticError ? (
        <div className="border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
          Failed to run the realtime origin diagnostic: {realtimeOriginDiagnosticError}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {realtime.started ? (
          <div className="inline-flex items-center gap-2 border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-200">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
            </span>
            Recording
          </div>
        ) : null}

        <button
          type="button"
          onClick={startRealtime}
          disabled={realtime.started}
          className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
        >
          {realtime.starting ? "Starting…" : "Start Recording"}
        </button>
        <button
          type="button"
          onClick={stopRealtime}
          disabled={!realtime.started}
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:opacity-60"
        >
          Stop
        </button>
      </div>

      {realtimeControlError ? <p className="text-xs text-red-500">{realtimeControlError}</p> : null}
      {realtimeMicrophoneError ? (
        <p className="text-xs text-red-500">{realtimeMicrophoneError}</p>
      ) : null}
      {realtimeLatestError ? (
        <div className="space-y-1 text-xs text-red-500">
          {hasOriginRejectionDiagnostic ? (
            <p>
              Realtime connection failed because Reson8 rejected the websocket handshake for this
              origin.
            </p>
          ) : null}
          <p>{realtimeLatestError}</p>
        </div>
      ) : null}
    </FormContainer>
  );
}

function RealtimeSpeechSectionFallback() {
  return (
    <FormContainer
      title="Realtime speech"
      eyebrow="Live microphone"
      description="Capture microphone audio in the browser, stream it to Reson8, and append final segments to the same conversation."
    >
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
        Realtime microphone capture is only available after this page hydrates in the browser.
      </div>
    </FormContainer>
  );
}

export default function BackofficeOrganisationReson8Transcribe() {
  const {
    models,
    configError,
    modelsError,
    realtimeOriginDiagnostic,
    realtimeOriginDiagnosticError,
  } = useLoaderData<typeof loader>();
  const { orgId } = useOutletContext<Reson8LayoutContext>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [prerecordedForm, setPrerecordedForm] = useState<PrerecordedFormState>(
    DEFAULT_PRERECORDED_FORM_STATE,
  );
  const [conversationEntries, setConversationEntries] = useState<ConversationEntry[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [realtimeInterimTranscript, setRealtimeInterimTranscript] = useState<string | null>(null);
  const [realtimeRecordingDownload, setRealtimeRecordingDownload] =
    useState<RealtimeRecordingDownload | null>(null);
  const [clearConversationVersion, setClearConversationVersion] = useState(0);
  const [isClient, setIsClient] = useState(false);
  const lastProcessedActionIdRef = useRef<string | null>(null);

  useEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    if (!actionData || !actionData.ok) {
      return;
    }

    if (lastProcessedActionIdRef.current === actionData.resultId) {
      return;
    }

    lastProcessedActionIdRef.current = actionData.resultId;
    setConversationEntries((entries) => [
      ...entries,
      {
        id: actionData.resultId,
        source: "prerecorded",
        title: actionData.fileName,
        text: actionData.transcription.text,
        createdAt: new Date().toISOString(),
      },
    ]);
    setPrerecordedForm((prev) => ({
      ...prev,
      fileName: "",
    }));
  }, [actionData]);

  const handlePrerecordedSubmit = (event: FormEvent<HTMLFormElement>) => {
    setLocalError(null);
    const fileInput = event.currentTarget.elements.namedItem("audioFile");
    if (!(fileInput instanceof HTMLInputElement) || !fileInput.files?.length) {
      setLocalError("Choose an audio file before submitting.");
      event.preventDefault();
    }
  };

  const transcriptionError =
    localError ?? (actionData && !actionData.ok ? actionData.message : null);
  const clearConversation = () => {
    setConversationEntries([]);
    setRealtimeInterimTranscript(null);
    setRealtimeRecordingDownload(null);
    setClearConversationVersion((value) => value + 1);
  };

  if (configError) {
    return (
      <div className="border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
        {configError}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="grid gap-4 xl:grid-cols-[1.05fr_1fr]">
        <div className="space-y-4">
          <FormContainer
            title="Prerecorded transcription"
            eyebrow="Upload audio"
            description="Submit an existing audio file and append the result to the shared conversation timeline."
          >
            <Form
              method="post"
              encType="multipart/form-data"
              onSubmit={handlePrerecordedSubmit}
              className="space-y-4"
            >
              <div className="grid gap-4 md:grid-cols-2">
                <FormField label="Audio file" hint="Any format Reson8 accepts upstream.">
                  <input
                    type="file"
                    name="audioFile"
                    accept="audio/*"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => {
                      setLocalError(null);
                      const nextFile = event.target.files?.[0] ?? null;
                      setPrerecordedForm((prev) => ({
                        ...prev,
                        fileName: nextFile?.name ?? "",
                      }));
                    }}
                    className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] file:mr-3 file:border-0 file:bg-transparent file:text-[var(--bo-fg)]"
                  />
                </FormField>

                <FormField label="Custom model" hint="Optional vocabulary boost for this upload.">
                  <select
                    name="customModelId"
                    value={prerecordedForm.customModelId}
                    onChange={(event) =>
                      setPrerecordedForm((prev) => ({
                        ...prev,
                        customModelId: event.target.value,
                      }))
                    }
                    className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
                  >
                    <option value="">No custom model</option>
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </FormField>
              </div>

              <div className="flex flex-wrap gap-3 text-sm text-[var(--bo-muted)]">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="includeTimestamps"
                    checked={prerecordedForm.includeTimestamps}
                    onChange={(event) =>
                      setPrerecordedForm((prev) => ({
                        ...prev,
                        includeTimestamps: event.target.checked,
                      }))
                    }
                    className="h-4 w-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]"
                  />
                  Include timestamps
                </label>
              </div>

              {prerecordedForm.fileName ? (
                <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
                  Ready to transcribe{" "}
                  <span className="text-[var(--bo-fg)]">{prerecordedForm.fileName}</span>.
                </div>
              ) : null}

              {transcriptionError ? (
                <p className="text-xs text-red-500">{transcriptionError}</p>
              ) : null}

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
              >
                {isSubmitting ? "Transcribing…" : "Transcribe file"}
              </button>
            </Form>
          </FormContainer>

          {isClient ? (
            <RealtimeSpeechSection
              orgId={orgId}
              models={models}
              realtimeOriginDiagnostic={realtimeOriginDiagnostic}
              realtimeOriginDiagnosticError={realtimeOriginDiagnosticError}
              onAppendEntries={(entries) => {
                setConversationEntries((currentEntries) => [...currentEntries, ...entries]);
              }}
              onInterimTranscriptChange={setRealtimeInterimTranscript}
              onRecordedAudioChange={setRealtimeRecordingDownload}
              clearConversationVersion={clearConversationVersion}
            />
          ) : (
            <RealtimeSpeechSectionFallback />
          )}
        </div>

        <div className="space-y-4">
          <FormContainer
            title="Current conversation"
            eyebrow="Shared output"
            description="Prerecorded uploads and live speech both append to the same running transcript."
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {realtimeRecordingDownload ? (
                  <a
                    href={realtimeRecordingDownload.url}
                    download={realtimeRecordingDownload.fileName}
                    className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                  >
                    Download audio
                  </a>
                ) : null}
                <button
                  type="button"
                  onClick={clearConversation}
                  className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                >
                  Clear conversation
                </button>
              </div>
            }
          >
            {modelsError ? (
              <div className="border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
                {modelsError}
              </div>
            ) : null}

            <div className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-sm text-[var(--bo-accent-fg)]">
              <p className="text-[10px] tracking-[0.22em] uppercase">Live interim</p>
              <p className="mt-2 whitespace-pre-wrap">{realtimeInterimTranscript || ""}</p>
            </div>

            {conversationEntries.length === 0 ? (
              <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
                No transcript yet. Upload an audio file or start recording to build the
                conversation.
              </div>
            ) : null}

            {conversationEntries.length === 0 ? null : (
              <div className="space-y-3">
                {conversationEntries.map((entry) => (
                  <article
                    key={entry.id}
                    className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                          {entry.source === "prerecorded" ? "Prerecorded" : "Transcript"}
                        </p>
                        {entry.title ? (
                          <h3 className="mt-1 text-sm font-semibold text-[var(--bo-fg)]">
                            {entry.title}
                          </h3>
                        ) : null}
                      </div>
                      <span className="text-xs text-[var(--bo-muted-2)]">
                        {new Date(entry.createdAt).toLocaleTimeString()}
                      </span>
                    </div>

                    <p className="mt-3 text-sm leading-6 whitespace-pre-wrap text-[var(--bo-fg)]">
                      {entry.text}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </FormContainer>
        </div>
      </section>
    </div>
  );
}
