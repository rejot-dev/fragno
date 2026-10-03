---
name: reson8-integration
description: >
  Use the native Backoffice Reson8 integration and reson8.* runtime tools. Load with
  configuring-integrations for speech-to-text setup; also use for audio transcription and Reson8
  runtime availability.
---

# Reson8 Integration

Use this skill for Reson8 speech-to-text setup and prerecorded audio transcription from Backoffice
automation runtimes.

# Reson8 configuration

Configuration fields:

- `apiKey`: Reson8 API key. Secret; required on first setup.

# Reson8 events

Cataloged automation events:

- `source`: `reson8`, `eventType`: `capability.configured` — fires after Reson8 is configured for an
  organization for the first time.

Treat Reson8 as a tool-backed capability: automations call Reson8 when they need speech-to-text
output.

# Reson8 tools

Reson8 tools can transcribe prerecorded audio files.

Supported transcription options include audio encoding, sample rate, channel count, custom model id,
timestamps, word-level details, and confidence values.

Use codemode first. The `reson8` provider transcribes prerecorded audio when the runtime is
available.
