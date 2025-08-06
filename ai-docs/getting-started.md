# Getting Started

Follow these **three** quick steps to add OmniAssist to your application.

---

## 1 · Install the packages

```bash
# Front-end (React example)
bun add omniassist-react  # or yarn / npm / pnpm

# Back-end
bun add omniassist-server openai zod  # peer deps: openai & zod
```

> OmniAssist is split into a thin client (`omniassist-react`, `omniassist-vue`, …) and a headless
> server (`omniassist-server`).

---

## 2 · Expose the assistant endpoint

Create a route the client can POST to. The server package ships with helpers for popular frameworks:

```ts title="/app/api/assistant/route.ts" lineNumbers
import { createAssistant, toNextJsHandler } from "omniassist-server/next-js";
import { myTools } from "~/lib/assistant-tools";

export const { POST } = toNextJsHandler(
  createAssistant({
    tools: myTools,
    openAIApiKey: process.env.OPENAI_API_KEY!,
  }),
);
```

Guides for Remix, Nuxt, Express, Hono, and more can be found in **[Integrations](integrations.md)**.

---

## 3 · Wrap your app with the provider & hook

```tsx title="/app/layout.tsx" lineNumbers
import { AssistantProvider } from "omniassist-react";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <AssistantProvider endpoint="/api/assistant">{children}</AssistantProvider>;
}
```

Add the chat widget somewhere:

```tsx title="/app/components/AssistantPanel.tsx"
import { ChatTimeline } from "omniassist-react";

export function AssistantPanel() {
  return <ChatTimeline />;
}
```

Done! Run your app, open the side-panel, and start chatting 🎉.

---

## Where to go next

- **[Concepts](concepts.md)** – Understand tools, context, and streaming.
- **[Extending Tools](extending-tools.md)** – Add your own capabilities.
- **[Vite Plugin](vite-plugin.md)** – Auto-generate route metadata for deeper context.
