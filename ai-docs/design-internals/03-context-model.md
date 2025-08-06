# 03 · Context Model & Collection

## 1. Event Types

| Type             | Triggered by                         | Payload                             |
| ---------------- | ------------------------------------ | ----------------------------------- | -------------------------- |
| `navigation`     | Router transition begins & completes | `{ location:string, state:"loading" | "idle", duration?:ms }`    |
| `formSubmission` | `fetcher.submit()` / `<form>` action | `{ action:string, method:"POST"     | "GET"…, formData:Record }` |
| `custom:<name>`  | `assistant.pushContext()`            | Developer-defined payload           |

All events extend `{ id:string; timestamp:number }`.

## 2. Front-end Capture Flow

```mermaid
graph TD
A[Router hook] -->|on change| B(Storage)
C[Form interceptor] --> B
B --> D[Context queue (in-memory)]
```

- Queue capped at **N = 50** messages.
- Oldest messages dropped when limit exceeded.

## 3. Compression Algorithm

1. **Group** consecutive identical event types.
2. **Format** each into human-readable bullet (rule-based).
3. **Join** with `\n`, prepend to user prompt.

Example output:

```
- 13:41 navigation to /dashboard/webhooks (idle)
- 13:42 formSubmission PATCH /dashboard/organisation X-Org-Id=123 name="Acme"
```

If total tokens > 200, run _secondary summariser_:

```ts
const summary = summariser.llm(`Summarise the following events:\n${log}`);
```

## 4. Privacy Filters

- Form field allow/deny lists.
- `redact(value)` helper for secrets (credit card, passwords).
- Option to disable context entirely: `<AssistantProvider disableContext />`.

## 5. Persistence Strategy (Optional)

The library **does not** persist context. Host app may subscribe to `onContext` and store logs for
analytics.

## 6. Open Questions

1. Should we serialise _raw_ router state for advanced AI reasoning?
2. Need heuristics to drop noisy events (e.g., mouse moves) – out of scope for MVP.
