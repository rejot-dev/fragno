# Vite Plugin

`@omniassist/vite-plugin` is an optional dev-tool that harvests route metadata from your codebase
and ships it to the assistant as structured data.

Why? The more the model knows about your navigation structure, the better it can suggest links and
decide when to call `navigate`.

---

## Installation

```bash
bun add -D @omniassist/vite-plugin
```

```ts title="vite.config.ts" lineNumbers
import { defineConfig } from "vite";
import omniAssist from "@omniassist/vite-plugin";

export default defineConfig({
  plugins: [
    omniAssist({
      /* options */
      include: ["src/routes/**/*.{tsx,vue,svelte}"],
    }),
  ],
});
```

---

## What it does

1. Scans your routes folder (configurable glob).
2. Extracts **path**, **name**, and (when possible) **Zod schema** for loaders/actions.
3. Emits `virtual:omniassist-routes` – a typed module consumed by the assistant server.
4. Enables type-ahead & autocomplete in VS Code for route names.

---

## Example generated module

```ts
export const routes = [
  {
    path: "/dashboard",
    name: "dashboard.home",
    params: {},
  },
  {
    path: "/dashboard/email/:id",
    name: "dashboard.email.detail",
    params: { id: "string" },
  },
];
```

You can then feed this into your system prompt:

```ts
createAssistant({
  systemPrompt: `Available pages: ${routes.map(r=>r.path).join("\n")}`,
  …
});
```

---

## Framework coverage

| Framework                               | Status                                  |
| --------------------------------------- | --------------------------------------- |
| Vite-based (Vanilla, React, Vue, Solid) | ✅ Stable                               |
| Next.js                                 | ✳️ Not needed – use the router manifest |
| Nuxt                                    | 🚧 In progress                          |
| Remix                                   | 🚧 PoC                                  |

Contributions welcome!
