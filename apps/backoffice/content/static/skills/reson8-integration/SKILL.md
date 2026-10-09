---
name: reson8-integration
description: >
  Use Reson8 through integrations.* for organization-scoped speech-to-text setup, action discovery,
  prerecorded audio transcription, and live access verification. Load configuring-integrations for
  the existing organization configuration controls.
---

# Reson8 Integration

Reson8 uses the selected organization's existing configuration slot, addressed as
`backoffice#reson8`. The same address in another organization selects that organization's slot; it
never selects another organization's credentials.

## Setup and verification

Check current requirements before submitting the requested API key:

```ts
const connectionId = "backoffice#reson8";
let setup = await integrations.setup({ kind: "check", connectionId });
if (setup.status === "needs-input") {
  setup = await integrations.setup({ kind: "input", connectionId, input: { apiKey } });
}
if (setup.status !== "ready") throw new Error("Reson8 setup is not ready.");
```

Setup stores the secret in the existing organization configuration store. Already-configured setup
returns ready without replacing the key; use organization configuration controls to replace or reset
credentials. Ready means configured, not verified with the provider.

`integrations.verify({ connectionId })` performs a read-only custom-model listing and returns
timestamped access evidence. It does not test transcription or retain a health result.
`integrations.get({ connectionId })` performs no live check.

## Transcription

Discover the authoritative input/output contracts with `integrations.actions({ connectionId })`. The
prerecorded transcription action is `prerecorded.transcribe`. Read audio as bytes, then supply its
JSON representation:

```ts
const bytes = await state.readFileBytes({ path: "/workspace/audio.wav" });
const transcript = await integrations.execute({
  connectionId: "backoffice#reson8",
  actionId: "prerecorded.transcribe",
  input: { audio: { bytes: Array.from(bytes) }, query: null },
});
```

`query: null` uses service defaults. For explicit encoding, sample rate, channel count, custom
model, timestamps, word details, or confidence options, follow the discovered action schema. Audio
is real file content, not a textual encoding of the file.

## Terminal

Each dashboard submission starts a fresh shell. These commands use the connection ID directly:

```sh
integrations.setup --connection-id 'backoffice#reson8'
integrations.setup --connection-id 'backoffice#reson8' \
  --input-json '{"apiKey":"YOUR_RESON8_API_KEY"}'
integrations.actions --connection-id 'backoffice#reson8'
integrations.verify --connection-id 'backoffice#reson8'
integrations.execute --connection-id 'backoffice#reson8' \
  --action-id prerecorded.transcribe \
  --input-json "$(cat /workspace/transcription-input.json)" \
  --print text
```

The transcription input file must match the discovered action schema. Omitted setup input checks
requirements; explicit JSON input, including null, submits a value for source validation.

## Authority and events

Execution requires both `integrations.execute` and native `reson8.use`. Setup and verification
require `integrations.manage`; configuration reads require `connections.read`, and submitted keys
require `connections.manage`. Reading an audio file also requires the applicable state/file access.

Setup, key replacement, and disconnect report `source: "integrations"` events `connection.ready` and
`connection.disconnected` with `subject.connectionId` = `backoffice#reson8`.
