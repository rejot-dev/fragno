# 04 · Tool System Design

## 1. Definition Grammar

```ts
export interface ToolDef<Params extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string; // snakeCase
  description: string; // ≤ 200 chars (shown to LLM)
  parameters: Params; // Zod schema
  deprecated?: boolean;
}
```

`defineTool()` helper preserves generic type so params flow into client handler.

## 2. Registration Flow

**Server:**

```ts
createAssistant({ tools: [navigateTool, submitFormTool] });
```

**Client:**

```ts
useAssistantTools({ navigate: (args) => router.push(args.path) });
```

> If a tool is declared on the server but no client handler is registered, the SDK logs a warning
> and returns `success:false`.

## 3. Execution Lifecycle

1. LLM emits `function_call` item with `name` & streaming `arguments`.
2. Client buffers JSON, validates against Zod.
3. Handler returns `{ success:boolean; message?:string }`.
4. SDK streams `function_call_output` back to server → provider → LLM.

## 4. Error Handling

| Scenario               | Behaviour                                              |
| ---------------------- | ------------------------------------------------------ |
| JSON parse fails       | Client emits _error message_ and marks tool as `error` |
| Zod validation fails   | Same as above                                          |
| Handler throws         | Caught, wrapped as `{ success:false, message }`        |
| LLM calls unknown tool | Ignored + warning logged                               |

## 5. Security Considerations

- Tool arguments validated on **both** client & server.
- Max arg JSON size = **4 KB** (configurable).
- Server may register _guard_ functions to allow/deny execution per user.

## 6. Extensibility Ideas

- Return richer result objects (tables, images) via `message_html` extension.
- Composable _tool chains_ (LLM calls `createUser`, then `sendInvite`).

---

See [extending-tools.md](../ai-docs/extending-tools.md) for developer-facing guide.
