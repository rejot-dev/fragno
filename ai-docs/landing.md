# OmniAssist – The Pluggable AI Assistant Framework

> Bring ChatGPT-style assistance directly into your product **without rebuilding your UI or
> backend.**

OmniAssist lets you drop-in a context-aware AI assistant that:

- Observes what your users are doing (navigation, form submissions, custom signals)
- Chats in natural language right inside your app
- Executes real actions by calling _tools_ that you expose (navigate, submit forms, fire web-hooks,
  …)
- Works with **any** frontend or backend framework via thin, auto-generated adapters

---

## Why OmniAssist?

1. **Framework agnostic** – React, Vue, Solid, Svelte, Vanilla JS… Express, Hono, Fastify, or
   Cloudflare Workers on the backend. Pick the stack you love – OmniAssist will fit.
2. **Zero-config context** – Navigation & form events are captured automatically. The assistant
   _knows_ what page the user is on and what they just did.
3. **Tool-based actions** – Define declarative tools with [Zod](https://zod.dev/) schemas. The LLM
   calls them, you decide what happens.
4. **Streaming & cheap** – Uses the OpenAI Responses API (GPT-4o by default) with server-sent
   events.
5. **Type-safe** – End-to-end types flow from your tool definitions to the generated client hooks.

---

## Core Building Blocks

```
┌──────────────┐     web-standard Request / Response      ┌──────────────┐
│ Front-end    │  ───────────────────────────────────────▶ │ OmniAssist   │
│ (React, …)   │                                         │  Backend     │
│              │ ◀─────────────────────────────────────── │  Adapter     │
└──────────────┘             SSE Stream                  └──────────────┘
        ▲                                                             │
        │          custom Tool calls (navigate, …)                    │
        └──────────────────────────────────────────────────────────────┘
```

- **Adapters** – Tiny wrappers that translate your framework’s routing & form API into OmniAssist’s
  standard events.
- **Context pipeline** – Events (navigation, form submission, anything you emit) are summarised into
  natural language and sent to the LLM.
- **Tools** – JSON-schema functions the LLM can call. Built-ins cover navigation & form submission;
  you can add your own in <10 lines.

---

## What Can It Do?

- “Rename my organisation to _Acme Inc_.” – Fills the existing rename form and submits it.
- “Take me to webhook settings.” – Navigates directly to `/dashboard/webhooks`.
- “Create three API keys called _dev_, _staging_, _prod_.” – Repeats the _create API key_ flow.
- “Show me emails created in the last hour.” – Switches to inbox & filters.

All powered by the same tool primitives.

---

## Try the Demo

Clone the example project and run `bun run dev` – you’ll get a fully-featured dashboard with
OmniAssist baked in.

---

## Next Steps

- **[Getting Started](getting-started.md)** – Add OmniAssist to a fresh app in 5 minutes.
- **[Integrations](integrations.md)** – Copy-&-paste guides for Next.js, Remix, Nuxt, Express, Hono,
  and more.
- **[Concepts](concepts.md)** – Deep dive into tools, context, and adapters.
