# @fragno-dev/reson8-fragment

Fragno fragment for the documented Reson8 API.

## Supported server routes

- `POST /auth/token`
- `GET /custom-model`
- `GET /custom-model/:id`
- `POST /custom-model`
- `POST /speech-to-text/prerecorded`

## Realtime support

The fragment still does **not** mount a Fragno server route for realtime WebSocket proxying.

Instead, the client helpers implement the documented realtime flow directly in the browser:

1. request a short-lived access token from the Fragno backend via `POST /auth/token`
2. connect to `wss://api.reson8.dev/v1/speech-to-text/realtime`
3. optionally capture microphone audio as PCM16 and stream it over the socket
4. consume reactive Nanostore-backed realtime state

## Server configuration

```ts
import { createReson8Fragment } from "@fragno-dev/reson8-fragment";

const reson8 = createReson8Fragment(
  {
    apiKey: process.env.RESON8_API_KEY,
  },
  {
    mountRoute: "/api",
  },
);
```

### Authentication resolution

For upstream Reson8 REST calls, the fragment resolves credentials in this order:

1. Incoming `Authorization` request header
2. `defaultAuthorization` in fragment config
3. `apiKey` in fragment config, sent as `ApiKey <key>`

## Client builders

```ts
import { createReson8FragmentClients } from "@fragno-dev/reson8-fragment";

const reson8 = createReson8FragmentClients({
  baseUrl: "http://localhost:3000",
});

await reson8.useRequestToken.mutateQuery({});
await reson8.useCustomModels.query();
await reson8.useCustomModel.query({ path: { id: "model_123" } });
await reson8.useCreateCustomModel.mutateQuery({
  body: {
    name: "Cardiology",
    description: "Cardiology-specific terminology",
    phrases: ["myocardial infarction"],
  },
});
await reson8.usePrerecordedTranscription.mutateQuery({
  query: {
    include_words: "true",
    include_timestamps: "true",
  },
  body: new Uint8Array([1, 2, 3]),
});
```

## Realtime helpers

`createReson8FragmentClients(...)` now exposes:

- `useAccessToken`
- `useMicrophoneCapture`
- `useRealtimeSession`
- `useRealtimeTranscriber`

### Low-level realtime session

```ts
const session = reson8.useRealtimeSession({
  query: {
    include_interim: true,
    include_words: true,
    include_timestamps: true,
  },
});

await session.connect();
session.sendAudio(new Uint8Array([1, 2, 3]));
session.flush();
```

`useRealtimeSession(...)` exposes reactive Nanostore-backed state for:

- `messages`
- `transcripts`
- `finalTranscripts`
- `interimTranscripts`
- `flushConfirmations`
- `unknownMessages`
- `errors`
- `closeEvents`
- `fullTranscript`
- `interimTranscript`
- `connectionState`

and imperative helpers:

- `connect()`
- `disconnect()`
- `sendAudio(...)`
- `flush()`
- `clearMessages()`
- `clearErrors()`

### Microphone capture

```ts
const mic = reson8.useMicrophoneCapture();

await mic.start({
  onAudioChunk(chunk) {
    console.log(chunk);
  },
});

await mic.stop();
```

The microphone helper captures audio with the Web Audio API and emits PCM16 little-endian chunks.

### Higher-level transcriber

```ts
const transcriber = reson8.useRealtimeTranscriber({
  query: {
    include_interim: true,
    include_words: true,
    include_timestamps: true,
  },
});

await transcriber.start();
transcriber.flush();

console.log(transcriber.fullTranscript);
console.log(transcriber.interimTranscript);

await transcriber.stop();
```

`useRealtimeTranscriber(...)` composes the token store, microphone capture, and realtime session
into one higher-level controller.

## Notes

- Prerecorded transcription expects `contentType: application/octet-stream` and forwards the raw
  request body upstream.
- Query params for prerecorded transcription follow the Reson8 docs: `encoding`, `sample_rate`,
  `channels`, `custom_model_id`, `include_timestamps`, `include_words`, and `include_confidence`.
- Realtime WebSocket connections use `Sec-WebSocket-Protocol: bearer, <access_token>` in the
  browser, matching the Reson8 docs.
- The higher-level transcriber streams microphone audio as `pcm_s16le` and sets `sample_rate` from
  the browser audio context.
