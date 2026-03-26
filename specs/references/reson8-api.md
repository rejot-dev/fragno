# Reson8 API Docs (Combined)

This file contains the full API reference content from `https://docs.reson8.dev/api/`.

---

# Reson8 Documentation

# API Reference

This section documents the Reson8 API endpoints. All endpoints are available at `api.reson8.dev`.

## Endpoints

- **Auth** - OAuth2 token endpoint for obtaining access tokens.
- **Speech to Text** - Real-time and prerecorded transcription.

## Page Structure

Each endpoint page follows a consistent layout:

- **Request** - Headers, query parameters, and example usage.
- **Response** - Field descriptions and example payloads. Some fields are included only depending on
  query parameters.
- **Sending / Receiving Messages** - For WebSocket endpoints, the messages that can be sent to and
  received from the server.
- **Errors** - HTTP status codes and error codes returned by the endpoint.

---

# Reson8 Documentation

# Request Token

Exchange an API key for a short-lived access token.

    POST https://api.reson8.dev/v1/auth/token

## Request

### Headers

| Header        | Value              | Description  |
| ------------- | ------------------ | ------------ |
| Authorization | `ApiKey <api_key>` | Your API key |

### Example

curlPython

    curl -X POST https://api.reson8.dev/v1/auth/token \
      -H "Authorization: ApiKey <your_api_key>"

    import requests

    response = requests.post(
        "https://api.reson8.dev/v1/auth/token",
        headers={"Authorization": "ApiKey <your_api_key>"},
    )

    token = response.json()["access_token"]

## Response

`200 OK`

### Fields

| Field          | Type   | Description                                |
| -------------- | ------ | ------------------------------------------ |
| `access_token` | string | The token to use in `Authorization` header |
| `token_type`   | string | Always `Bearer`                            |
| `expires_in`   | number | Token lifetime in seconds                  |

### Example

    {
      "access_token": "<your_access_token>",
      "token_type": "Bearer",
      "expires_in": 600
    }

## Errors

| Status | Code             | Description                |
| ------ | ---------------- | -------------------------- |
| 401    | `UNAUTHORIZED`   | Missing or invalid API key |
| 500    | `INTERNAL_ERROR` | Unexpected server error    |

---

# Reson8 Documentation

# Create Custom Model

Create a new custom model with an initial set of phrases.

    POST https://api.reson8.dev/v1/custom-model

## Request

### Headers

| Header        | Value                                         |
| ------------- | --------------------------------------------- |
| Authorization | `ApiKey <api_key>` or `Bearer <access_token>` |
| Content-Type  | `application/json`                            |

### Body

| Field         | Type       | Required | Description                         |
| ------------- | ---------- | -------- | ----------------------------------- |
| `name`        | string     | Yes      | Name of the custom model            |
| `description` | string     | Yes      | Description of the custom model     |
| `phrases`     | string\[\] | Yes      | List of phrases (must not be empty) |

### Example

curlPython

    curl -X POST "https://api.reson8.dev/v1/custom-model" \
      -H "Authorization: ApiKey <your_api_key>" \
      -H "Content-Type: application/json" \
      -d '{
        "name": "Cardiology",
        "description": "Cardiology-specific terminology",
        "phrases": ["myocardial infarction", "atrial fibrillation", "echocardiogram"]
      }'

    import requests

    response = requests.post(
        "https://api.reson8.dev/v1/custom-model",
        headers={
            "Authorization": "ApiKey <your_api_key>",
            "Content-Type": "application/json",
        },
        json={
            "name": "Cardiology",
            "description": "Cardiology-specific terminology",
            "phrases": ["myocardial infarction", "atrial fibrillation", "echocardiogram"],
        },
    )

    custom_model = response.json()

## Response

`201 Created`

| Field         | Type   | Description                           |
| ------------- | ------ | ------------------------------------- |
| `id`          | string | Unique identifier of the custom model |
| `name`        | string | Name of the custom model              |
| `description` | string | Description of the custom model       |
| `phraseCount` | number | Number of phrases in the custom model |

### Example

    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "name": "Cardiology",
      "description": "Cardiology-specific terminology",
      "phraseCount": 3
    }

## Errors

| Status | Code              | Description                    |
| ------ | ----------------- | ------------------------------ |
| 400    | `INVALID_REQUEST` | Missing or invalid fields      |
| 401    | `UNAUTHORIZED`    | Invalid or expired credentials |
| 500    | `INTERNAL_ERROR`  | Unexpected server error        |

---

# Reson8 Documentation

# Get Custom Model

Get a single custom model by ID.

    GET https://api.reson8.dev/v1/custom-model/{id}

## Request

### Headers

| Header        | Value                                         |
| ------------- | --------------------------------------------- |
| Authorization | `ApiKey <api_key>` or `Bearer <access_token>` |

### Path Parameters

| Parameter | Type   | Description            |
| --------- | ------ | ---------------------- |
| `id`      | string | ID of the custom model |

### Example

curlPython

    curl "https://api.reson8.dev/v1/custom-model/a1b2c3d4-e5f6-7890-abcd-ef1234567890" \
      -H "Authorization: ApiKey <your_api_key>"

    import requests

    response = requests.get(
        "https://api.reson8.dev/v1/custom-model/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        headers={"Authorization": "ApiKey <your_api_key>"},
    )

    custom_model = response.json()

## Response

`200 OK`

| Field         | Type   | Description                           |
| ------------- | ------ | ------------------------------------- |
| `id`          | string | Unique identifier of the custom model |
| `name`        | string | Name of the custom model              |
| `description` | string | Description of the custom model       |
| `phraseCount` | number | Number of phrases in the custom model |

### Example

    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "name": "Cardiology",
      "description": "Cardiology-specific terminology",
      "phraseCount": 3
    }

## Errors

| Status | Code             | Description                    |
| ------ | ---------------- | ------------------------------ |
| 401    | `UNAUTHORIZED`   | Invalid or expired credentials |
| 404    | `NOT_FOUND`      | Custom model not found         |
| 500    | `INTERNAL_ERROR` | Unexpected server error        |

---

# Reson8 Documentation

# List Custom Models

List all custom models for the authenticated organization.

    GET https://api.reson8.dev/v1/custom-model

## Request

### Headers

| Header        | Value                                         |
| ------------- | --------------------------------------------- |
| Authorization | `ApiKey <api_key>` or `Bearer <access_token>` |

### Example

curlPython

    curl "https://api.reson8.dev/v1/custom-model" \
      -H "Authorization: ApiKey <your_api_key>"

    import requests

    response = requests.get(
        "https://api.reson8.dev/v1/custom-model",
        headers={"Authorization": "ApiKey <your_api_key>"},
    )

    custom_models = response.json()

## Response

`200 OK`

| Field         | Type   | Description                           |
| ------------- | ------ | ------------------------------------- |
| `id`          | string | Unique identifier of the custom model |
| `name`        | string | Name of the custom model              |
| `description` | string | Description of the custom model       |
| `phraseCount` | number | Number of phrases in the custom model |

### Example

    [
      {
        "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "name": "Cardiology",
        "description": "Cardiology-specific terminology",
        "phraseCount": 3
      }
    ]

## Errors

| Status | Code             | Description                    |
| ------ | ---------------- | ------------------------------ |
| 401    | `UNAUTHORIZED`   | Invalid or expired credentials |
| 500    | `INTERNAL_ERROR` | Unexpected server error        |

---

# Reson8 Documentation

# Prerecorded

Transcribe a complete audio file.

    POST https://api.reson8.dev/v1/speech-to-text/prerecorded

## Request

### Headers

| Header        | Value                                         |
| ------------- | --------------------------------------------- |
| Authorization | `ApiKey <api_key>` or `Bearer <access_token>` |
| Content-Type  | `application/octet-stream`                    |

### Query Parameters

| Parameter            | Type    | Default | Description                                                                                                                          |
| -------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `encoding`           | string  | `auto`  | Audio encoding: `auto` or `pcm_s16le`                                                                                                |
| `sample_rate`        | number  | `16000` | Sample rate in Hz (only used depending on encoding)                                                                                  |
| `channels`           | number  | `1`     | Number of audio channels (only used depending on encoding)                                                                           |
| `custom_model_id`    | string  |         | Optional. ID of a [custom model](../../custom-model/create/) to bias transcription. Overrides the model configured on the API client |
| `include_timestamps` | boolean | `false` | Include `start_ms` and `duration_ms` on transcripts and words                                                                        |
| `include_words`      | boolean | `false` | Include word-level detail on transcripts                                                                                             |
| `include_confidence` | boolean | `false` | Include `confidence` on words                                                                                                        |

### Example

curlPython

    curl -X POST "https://api.reson8.dev/v1/speech-to-text/prerecorded" \
      -H "Authorization: ApiKey <your_api_key>" \
      -H "Content-Type: application/octet-stream" \
      --data-binary @recording.wav

    import requests

    with open("recording.wav", "rb") as f:
        response = requests.post(
            "https://api.reson8.dev/v1/speech-to-text/prerecorded",
            headers={
                "Authorization": "ApiKey <your_api_key>",
                "Content-Type": "application/octet-stream",
            },
            data=f,
        )

    transcript = response.json()

## Response

`200 OK`

### Fields

| Field         | Type   | Included                       | Description                       |
| ------------- | ------ | ------------------------------ | --------------------------------- |
| `text`        | string | Always                         | Full transcript of the audio file |
| `start_ms`    | number | When `include_timestamps=true` | Start time in milliseconds        |
| `duration_ms` | number | When `include_timestamps=true` | Duration in milliseconds          |
| `words`       | array  | When `include_words=true`      | Word-level detail                 |

Each word contains:

| Field         | Type   | Included                       | Description                |
| ------------- | ------ | ------------------------------ | -------------------------- |
| `text`        | string | Always                         | The recognized word        |
| `start_ms`    | number | When `include_timestamps=true` | Start time in milliseconds |
| `duration_ms` | number | When `include_timestamps=true` | Duration in milliseconds   |
| `confidence`  | number | When `include_confidence=true` | Confidence score (0 to 1)  |

### Example

DefaultEverything Included

    {
      "text": "the patient presented with chest pain and shortness of breath"
    }

    {
      "text": "the patient presented with chest pain and shortness of breath",
      "start_ms": 0,
      "duration_ms": 4800,
      "words": [
        { "text": "the", "start_ms": 0, "duration_ms": 200, "confidence": 0.99 },
        { "text": "patient", "start_ms": 210, "duration_ms": 450, "confidence": 0.98 },
        { "text": "presented", "start_ms": 680, "duration_ms": 500, "confidence": 0.97 },
        { "text": "with", "start_ms": 1200, "duration_ms": 200, "confidence": 0.99 },
        { "text": "chest", "start_ms": 1420, "duration_ms": 350, "confidence": 0.96 },
        { "text": "pain", "start_ms": 1800, "duration_ms": 600, "confidence": 0.97 },
        { "text": "and", "start_ms": 2500, "duration_ms": 200, "confidence": 0.99 },
        { "text": "shortness", "start_ms": 2720, "duration_ms": 500, "confidence": 0.95 },
        { "text": "of", "start_ms": 3240, "duration_ms": 150, "confidence": 0.99 },
        { "text": "breath", "start_ms": 3410, "duration_ms": 1390, "confidence": 0.96 }
      ]
    }

## Errors

| Status | Code                | Description                     |
| ------ | ------------------- | ------------------------------- |
| 400    | `INVALID_REQUEST`   | Missing or invalid parameters   |
| 401    | `UNAUTHORIZED`      | Invalid or expired access token |
| 413    | `PAYLOAD_TOO_LARGE` | Audio file exceeds maximum size |
| 500    | `INTERNAL_ERROR`    | Unexpected server error         |

---

# Reson8 Documentation

# Realtime

Real-time speech-to-text transcription over WebSocket.

    wss://api.reson8.dev/v1/speech-to-text/realtime

## Request

### Headers

| Header                 | Value                                         |
| ---------------------- | --------------------------------------------- |
| Authorization          | `ApiKey <api_key>` or `Bearer <access_token>` |
| Sec-WebSocket-Protocol | `bearer, <access_token>`                      |

See [Authentication](../../../documentation/general/authentication/) for which header to use in
different situations.

### Query Parameters

| Parameter            | Type    | Default | Description                                                                                                                          |
| -------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `encoding`           | string  | `auto`  | Audio encoding: `auto` or `pcm_s16le`                                                                                                |
| `sample_rate`        | number  | `16000` | Sample rate in Hz (only used depending on encoding)                                                                                  |
| `channels`           | number  | `1`     | Number of audio channels (only used depending on encoding)                                                                           |
| `custom_model_id`    | string  |         | Optional. ID of a [custom model](../../custom-model/create/) to bias transcription. Overrides the model configured on the API client |
| `include_timestamps` | boolean | `false` | Include `start_ms` and `duration_ms` on transcripts and words                                                                        |
| `include_words`      | boolean | `false` | Include word-level detail on transcripts                                                                                             |
| `include_confidence` | boolean | `false` | Include `confidence` on words                                                                                                        |
| `include_interim`    | boolean | `false` | Include interim (partial) results and the `is_final` flag                                                                            |

### Example

PythonJavaScript (Browser)

    import asyncio
    import websockets

    async def transcribe():
        url = "wss://api.reson8.dev/v1/speech-to-text/realtime"
        headers = {"Authorization": "ApiKey <your_api_key>"}

        async with websockets.connect(url, additional_headers=headers) as ws:
            # Send audio data and control messages...

            async for message in ws:
                print(message)

    asyncio.run(transcribe())

    const token = "<your_access_token>";
    const url = "wss://api.reson8.dev/v1/speech-to-text/realtime";

    // Passes token via Sec-WebSocket-Protocol header
    const ws = new WebSocket(url, ["bearer", token]);

    ws.onopen = () => {
      // Send audio data and control messages...
    };

    ws.onmessage = (event) => {
      console.log(event.data);
    };

## Sending Messages

### Audio

Binary WebSocket frame containing audio data.

### Flush Request

Force the server to finalize any buffered audio and return a transcript.

    {
      "type": "flush_request",
      "id": "abc123"
    }

| Field | Type   | Required | Description                                                       |
| ----- | ------ | -------- | ----------------------------------------------------------------- |
| `id`  | string | No       | Optional identifier, returned in the flush corresponding response |

## Receiving Messages

### Transcript

Returned when speech is recognized. By default, only final results are returned. When
`include_interim=true`, interim (partial) results are also returned — these may change as more audio
is processed.

DefaultEverything Included

    {
      "type": "transcript",
      "text": "the patient presented with chest pain"
    }

    {
      "type": "transcript",
      "text": "the patient presented with chest pain",
      "is_final": true,
      "start_ms": 1200,
      "duration_ms": 2400,
      "words": [
        { "text": "the", "start_ms": 1200, "duration_ms": 200, "confidence": 0.99 },
        { "text": "patient", "start_ms": 1410, "duration_ms": 450, "confidence": 0.98 },
        { "text": "presented", "start_ms": 1880, "duration_ms": 500, "confidence": 0.97 },
        { "text": "with", "start_ms": 2400, "duration_ms": 200, "confidence": 0.99 },
        { "text": "chest", "start_ms": 2620, "duration_ms": 350, "confidence": 0.96 },
        { "text": "pain", "start_ms": 3000, "duration_ms": 600, "confidence": 0.97 }
      ]
    }

| Field         | Type    | Included                       | Description                           |
| ------------- | ------- | ------------------------------ | ------------------------------------- |
| `text`        | string  | Always                         | The recognized text                   |
| `is_final`    | boolean | When `include_interim=true`    | `true` for final, `false` for interim |
| `start_ms`    | number  | When `include_timestamps=true` | Start time in milliseconds            |
| `duration_ms` | number  | When `include_timestamps=true` | Duration in milliseconds              |
| `words`       | array   | When `include_words=true`      | Word-level detail                     |

Each word contains:

| Field         | Type   | Included                       | Description                |
| ------------- | ------ | ------------------------------ | -------------------------- |
| `text`        | string | Always                         | The recognized word        |
| `start_ms`    | number | When `include_timestamps=true` | Start time in milliseconds |
| `duration_ms` | number | When `include_timestamps=true` | Duration in milliseconds   |
| `confidence`  | number | When `include_confidence=true` | Confidence score (0 to 1)  |

### Flush Confirmation

Sent after a flush request has been processed. Includes the `id` if one was provided in the request.

    {
      "type": "flush_confirmation",
      "id": "abc123"
    }

| Field | Type   | Included | Description                                                                         |
| ----- | ------ | -------- | ----------------------------------------------------------------------------------- |
| `id`  | string | Always   | The identifier from the corresponding flush request, or `null` if none was provided |

## Errors

| Status | Code              | Description                    |
| ------ | ----------------- | ------------------------------ |
| 400    | `INVALID_REQUEST` | Missing or invalid parameters  |
| 401    | `UNAUTHORIZED`    | Invalid or expired credentials |
| 500    | `INTERNAL_ERROR`  | Unexpected server error        |
