# Extending Tools

Built-in tools (`navigate`, `submitForm`) cover common UI tasks, but the real power comes from
**custom tools**. Anything you can express as a pure function can be wired in.

---

## 1 · Define the tool

```ts title="/lib/assistant-tools.ts"
import { z } from "zod";
import { defineTool } from "omniassist-server";

export const createProjectTool = defineTool({
  name: "createProject",
  description: "Create a new project for the active organisation",
  parameters: z.object({
    name: z.string().min(3),
    visibility: z.enum(["public", "private"]).default("private"),
  }),
});
```

`defineTool()` just mirrors the object but adds some TS magic so the parameter type flows
everywhere.

---

## 2 · Expose it on the server

```ts title="/server/assistant.ts"
import { createAssistant } from "omniassist-server";
import { createProjectTool } from "./assistant-tools";

export const assistant = createAssistant({
  tools: [createProjectTool],
  openAIApiKey: process.env.OPENAI_API_KEY!,
  // optional: systemPrompt, model, contextCompressor, …
});
```

---

## 3 · Handle it on the client

```tsx title="/app/hooks/useAssistantTools.tsx"
import { useAssistantTools } from "omniassist-react";

export function useExtraTools() {
  useAssistantTools({
    createProject: async ({ name, visibility }) => {
      await fetch("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name, visibility }),
      });
      return `Project '${name}' created.`;
    },
  });
}
```

This hook registers runtime handlers; when the LLM calls `createProject`, the promise resolves and
the result is streamed back as a _function_call_output_ message.

---

## 4 · Prompting tips

LLMs must _know_ the tool exists. The assistant automatically includes the JSON-schema in the
request and trust OpenAI’s tool selection. Good descriptions increase the chance the tool is
invoked.

- Use imperative verb prefixes: **create**, **update**, **send**…
- Be explicit about side-effects.
- Provide examples in the `description` if ambiguous.

---

That’s it – your new capability is live!
