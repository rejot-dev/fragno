# 02 · High-Level Architecture

```
sequenceDiagram
  participant FE as Front-end Adapter
  participant BE as Back-end Adapter
  participant OA as OpenAI
  participant APP as Host App

  User->>FE: Prompt / UI events
  FE->>BE: POST /assistant  (messages + context)
  BE->>OA: responses.create(stream=true)
  OA-->>BE: SSE stream (text & tool calls)
  BE-->>FE: SSE proxy
  FE-->>APP: Execute tool handler
  APP-->>FE: Result / Error
  FE-->>BE: tool_call_output
  BE-->>OA: responses.toolSubmit()
```

_All interactions are stateless. FE keeps transient state (chat, abort controllers)._

## 1. Packages & Layers

| Layer              | Package                                    | Responsibility                                 |
| ------------------ | ------------------------------------------ | ---------------------------------------------- |
| Front-end core     | `@omniassist/core`                         | Message model, context compressor (isomorphic) |
| Front-end adapters | `omniassist-react`, `omniassist-vue`, …    | Hook into router/form APIs & expose hooks      |
| Back-end core      | `@omniassist/server`                       | Assistant engine, provider abstraction         |
| Back-end adapters  | `omniassist-express`, `omniassist-hono`, … | Translate Request/Response APIs                |
| Dev-tools          | `@omniassist/vite-plugin`                  | Static analysis for routes & zod schemas       |

## 2. Data Model

```ts
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}
interface ContextMessage {
  id: string;
  type: "navigation" | "form" | string;
  data: unknown;
}
interface FunctionCall {
  id: string;
  name: string;
  arguments: unknown;
}
```

All messages are serialised to JSON and validated with Zod on both sides.

## 3. Provider Abstraction

```ts
interface LLMProvider {
  stream(request: LLMPayload): AsyncIterable<LLMEvent>;
}
```

We ship a default `OpenAIProvider`. Future: Anthropic, local Llama via Ollama.

## 4. Context Compression

1. Keep sliding window of last **N = 20** context messages.
2. Compress into bullet list using rule-based templating (no extra token cost).
3. Optionally run secondary LLM summariser if context > 4 KB.

## 5. Fault Tolerance

- Network failures: client retries with exponential back-off.
- Tool handler errors: streamed back as `function_call_output` with `status:incomplete`.
- SSE disconnect: FE auto-reconnects if last event < 1 s ago.

## 6. Extensibility Points

- `registerTool(tool, handler)` – runtime registration.
- `addContext(message)` – push custom events (analytics, feature flags).
- `setSystemPrompt(fn)` – override prompt factory per request.

---

See [03-context-model](03-context-model.md) and [04-tool-system](04-tool-system.md) for deeper
dives.
