import { createReson8FragmentClient } from "@fragno-dev/reson8-fragment/vanilla";

import type { DictationAdapter } from "@assistant-ui/react";

/** How long stopping waits for Reson8 to transcribe the audio sent before the flush. */
const FLUSH_TIMEOUT_MS = 5_000;

type Reson8Client = ReturnType<typeof createReson8FragmentClient>;
type Reson8Transcriber = ReturnType<Reson8Client["useRealtimeTranscriber"]>;

/**
 * Streams the microphone to Reson8 and writes its transcript into the composer: interim text as
 * the user speaks, then each final segment.
 */
export function createReson8DictationAdapter(mountRoute: string): DictationAdapter {
  // Created on first use, in the browser; consecutive dictations then reuse an unexpired token.
  let client: Reson8Client | null = null;
  return {
    listen() {
      client ??= createReson8FragmentClient({ mountRoute });
      return listenWithReson8(client.useRealtimeTranscriber({ query: { include_interim: true } }));
    },
  };
}

function listenWithReson8(transcriber: Reson8Transcriber): DictationAdapter.Session {
  const startListeners = new Set<() => void>();
  const speechListeners = new Set<(result: DictationAdapter.Result) => void>();
  const endListeners = new Set<(result: DictationAdapter.Result) => void>();
  let status: DictationAdapter.Status = { type: "starting" };
  let deliveredFinals = 0;

  const unsubscribeTranscripts = transcriber.transcripts.listen((transcripts) => {
    const finals = transcripts.filter((transcript) => transcript.is_final !== false);
    for (const final of finals.slice(deliveredFinals)) {
      const text = final.text.trim();
      if (text) {
        emit(speechListeners, { transcript: text, isFinal: true });
      }
    }
    deliveredFinals = finals.length;
    const latest = transcripts.at(-1);
    if (latest?.is_final === false) {
      emit(speechListeners, { transcript: latest.text.trim(), isFinal: false });
    }
  });
  // A dropped socket ends dictation; what was transcribed stays in the composer.
  const unsubscribeConnection = transcriber.connectionState.listen((state) => {
    if (status.type === "running" && (state === "closed" || state === "error")) {
      end(state === "error" ? "error" : "stopped");
    }
  });

  function end(reason: Extract<DictationAdapter.Status, { type: "ended" }>["reason"]) {
    if (status.type === "ended") {
      return;
    }
    status = { type: "ended", reason };
    unsubscribeTranscripts();
    unsubscribeConnection();
    void transcriber.disconnect();
    emit(endListeners, { transcript: transcriber.fullTranscript.get() });
  }

  transcriber.start().then(
    () => {
      // Ended while the microphone or socket was still opening: release them now.
      if (status.type === "ended") {
        void transcriber.disconnect();
        return;
      }
      status = { type: "running" };
      emit(startListeners, undefined);
    },
    () => {
      end("error");
    },
  );

  return {
    get status() {
      return status;
    },
    async stop() {
      if (status.type === "running") {
        const flushId = await transcriber.stop({ flush: true });
        if (flushId) {
          await flushed(transcriber, flushId);
        }
      }
      end("stopped");
    },
    cancel() {
      end("cancelled");
    },
    onSpeechStart: (callback) => subscribe(startListeners, callback),
    onSpeech: (callback) => subscribe(speechListeners, callback),
    onSpeechEnd: (callback) => subscribe(endListeners, callback),
  };
}

/** Resolves once Reson8 confirms the flush, the socket closes, or the wait times out. */
function flushed(transcriber: Reson8Transcriber, flushId: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(settle, FLUSH_TIMEOUT_MS);
    const unsubscribeConfirmations = transcriber.flushConfirmations.subscribe((confirmations) => {
      if (confirmations.some((confirmation) => confirmation.id === flushId)) {
        settle();
      }
    });
    const unsubscribeConnection = transcriber.connectionState.subscribe((state) => {
      if (state === "closed" || state === "error") {
        settle();
      }
    });
    function settle() {
      clearTimeout(timer);
      // Subscribing calls back immediately, so settle can run before the unsubscribers exist.
      queueMicrotask(() => {
        unsubscribeConfirmations();
        unsubscribeConnection();
      });
      resolve();
    }
  });
}

function subscribe<T>(listeners: Set<(value: T) => void>, callback: (value: T) => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function emit<T>(listeners: Set<(value: T) => void>, value: T) {
  for (const listener of listeners) {
    listener(value);
  }
}
