# Core Concepts

Understanding these four concepts will make extending OmniAssist trivial.

---

## 1 · Context

Context is **what the user just did** – the page they opened, the form they submitted, or any signal
you emit.

The client captures framework-specific events and converts them into _context messages_:

```diff
✔ navigation  /dashboard/email              (idle)
✔ formSubmit  /dashboard/email/create  { address:"info@acme.io" }
```

Before every LLM call, the last N messages are summarised into a plain-English bullet list and
prepended to the chat. You can push your own events with
`assistant.pushContext({ type:"myEvent", data:{…} })`.

---

## 2 · Tools

Tools are strongly-typed functions the LLM can invoke. Each tool definition contains:

```ts
{
  name: "navigate",
  description: "Navigate user to a new route",
  parameters: z.object({ path:z.string(), reason:z.string() })
}
```

_Parameters_ use Zod, then converted to JSON-Schema so OpenAI can validate them server-side.

When the assistant decides to call a tool, the client receives a **function_call** event, executes
your handler, and streams the result back.

---

## 3 · Adapters

Adapters are the small glue layer between OmniAssist and your framework.

Frontend adapter responsibilities:

1. Provide a _Provider_ (context) so any component can call `useAssistantChat()`.
2. Translate navigation & form events into context messages.
3. Execute built-in tool handlers (`navigate`, `submitForm`).

Backend adapter responsibilities:

1. Turn your framework’s _Request_ object into a standard Web Request.
2. Hook up streaming response (`Response` or `ReadableStream`).

Most adapters are less than 50 LOC – browse the `omniassist-react` or `omniassist-next-js` packages
for reference.

---

## 4 · Streaming lifecycle

1. **User** submits a prompt → client appends it to the message list.
2. **Client** POSTs messages + context to `/assistant`.
3. **Server** pipes them to OpenAI `responses.create({ stream:true })`.
4. **Client** receives `response.output_text.delta` events and renders the assistant reply _token by
   token_.
5. Optional `function_call_arguments` events are processed and tools executed.
6. A final `completed` event marks the end of the interaction.

Because everything is streamed you get sub-second feedback and low latency tool calls.
