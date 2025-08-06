# 01 · Requirements

## 1. Product Goals

1. Embed a ChatGPT-style assistant inside any SaaS dashboard in **< 15 minutes**.
2. Assistant must:
   - Observe user navigation & form submissions
   - Execute real actions via developer-defined _tools_
   - Stream responses with <300 ms first token latency (P95)
3. Support at least **React/Next.js**, **Vue/Nuxt**, **Remix/React-Router**, and **plain JS**
   front-ends.
4. Support **Node (Express/Fastify)**, **Bun/Hono**, and **Cloudflare Workers** back-ends.
5. Default provider: **OpenAI GPT-4o**. Architecture must allow pluggable LLMs.

## 2. Engineering Requirements

| Area          | Requirement                                                |
| ------------- | ---------------------------------------------------------- |
| Type-safety   | End-to-end TypeScript (≥ 5.4). Zod for runtime validation. |
| Streaming     | Use Web-standard _ReadableStream_ / _SSE_ end-to-end.      |
| Extensibility | Developers can register custom tools with <10 LOC.         |
| Bundle Size   | Client adapter ≤ 8 kB gzip for React.                      |
| Serverless    | No stateful processes – stateless handlers only.           |
| Testing       | 90 %+ unit test coverage on core packages.                 |
| Observability | Built-in hooks for logging, tracing (OpenTelemetry).       |

## 3. Non-Goals

- Persistent chat history storage (left to host app).
- Automatic generation of domain-specific tools (future work).
- Full-text search or analytics over chat transcripts.

## 4. Success Metrics

1. **Time to first assistant reply** ≤ 1 s on average demo.
2. **Adapter LOC**: adding a new front-end adapter ≤ 50 LOC.
3. At least **3 production integrations** within 6 months.

## 5. Open Questions

- Do we need offline / background task execution?
- How to handle rate-limits across shared OpenAI keys?
- Should we offer built-in Redis caching for embeddings?  
  _(Track in Roadmap)_
