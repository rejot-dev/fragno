# Integrations

Copy the snippet for your stack, change the import path to your own `assistant.ts` file, and you’re
ready.

---

## Backend Adapters

### Next.js (App Router)

```ts title="/app/api/assistant/route.ts"
import { assistant } from "~/server/assistant";
import { toNextJsHandler } from "omniassist-server/next-js";

export const { POST } = toNextJsHandler(assistant);
```

### Remix

```ts title="/app/routes/api.assistant.$.ts"
import { assistant } from "~/server/assistant";
import { toRemixHandler } from "omniassist-server/remix";

export const action = toRemixHandler(assistant);
export const loader = toRemixHandler(assistant);
```

### Nuxt 3

```ts title="/server/api/assistant.ts"
import { assistant } from "~/server/assistant";

export default defineEventHandler((event) => assistant.handler(toWebRequest(event)));
```

### Express

```ts title="/src/server.ts"
import express from "express";
import { assistant } from "./assistant";

const app = express();
app.post("/assistant", async (req, res) => assistant.handler(req, res));
```

### Hono (Cloudflare Workers / Bun / Node)

```ts title="/src/assistant.ts"
import { Hono } from "hono";
import { assistant } from "./assistant-core";

export const app = new Hono();
app.route("/assistant", assistant.asHonoRoute());
```

---

## Front-end Adapters

| Framework               | Package            | Provider / Hook                              |
| ----------------------- | ------------------ | -------------------------------------------- |
| React / Remix / Next.js | `omniassist-react` | `<AssistantProvider>` & `useAssistantChat()` |
| Vue / Nuxt              | `omniassist-vue`   | `<AssistantProvider>` & `useAssistantChat()` |
| SolidJS                 | `omniassist-solid` | `<AssistantProvider>` & `useAssistantChat()` |
| Svelte                  | _coming soon_      |                                              |

All clients expose the same minimal surface area:

```ts
const { messages, submit, clear } = useAssistantChat();
```

---

## Custom Frameworks

If your favourite framework isn’t listed, you can build an adapter in **~30 LOC**. See
**[Adapters](concepts.md#adapters)** for details.
