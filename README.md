# Fragno

Fragno is the <ins>fr</ins>amework-<ins>agno</ins>stic toolkit for building full-stack TypeScript
libraries that work seamlessly across different frameworks and environments. Your users will
integrate in a single line of code. Write your API once, get type-safe clients for React, Vue, and
vanilla JavaScript automatically. Fully type safe.

## Features

- 🔐 **End-to-end type safety** - From server to client, everything is typed
- 🎯 **Framework agnostic** - Works with React, Vue, Next.js, Nuxt, React Router, with more on the
  roadmap.
- 📦 **Automatic code splitting** - Server code never reaches the client bundle
- 🚀 **Built-in state management** - Reactive stores with caching (TanStack Query-style)
- 🌊 **Streaming support** - Real-time data with NDJSON (New-line Delimited JSON) streaming
- 🔄 **Middleware support** - Users can use middleware for custom request processing such as
  authentication.
- 🛠️ **Developer friendly** - Simple API, great TypeScript support

## Framework Support Matrix

| Client-side Frameworks | Support | —   | Server-side Frameworks  | Support    |
| ---------------------- | ------- | --- | ----------------------- | ---------- |
| React                  | ✅      |     | Node.js / Express       | ✅         |
| Vue                    | ✅      |     | React Router v7 / Remix | ✅         |
| Vanilla JavaScript     | ✅      |     | Astro                   | ✅         |
| Svelte                 | ✅      |     | Next.js                 | ✅         |
|                        |         |     | Nuxt                    | ✅         |
|                        |         |     | SvelteKit               | ✅         |
|                        |         |     | Tanstack Start          | 🔄 Planned |

## Usage

### NextJS / Backend

As a user of a Fragment (library built w/ Fragno), you integrate with only a couple of lines of
code.

```typescript app/api/example-fragment/[...all]/route.ts
// app/api/example-fragment/[...all]/route.ts
import { createExampleFragment } from "@fragno-dev/example-fragment";
import { toNextJsHandler } from "@fragno-dev/core/next-js";

const exampleFragment = createExampleFragment({});
export const { GET, POST, PUT, PATCH, DELETE } = toNextJsHandler(exampleFragment);
```

Similar patterns apply for other frameworks as well.

### React / Client

On the frontend, the user gets fully-typed TanStack Query-style hooks.

```typescript
// src/app/my-component.tsx
import { createExampleFragmentClient } from "@fragno-dev/example-fragment/react";
const { useTodos, useAddTodo } = createExampleFragmentClient();

export default function MyComponent() {
  const { data: todos, loading: todosLoading } = useTodos();
  const { mutate: addTodo, loading: addTodoLoading } = useAddTodo();

  return (
    <div>
      {todos?.map(todo => (
        <div key={todo.id}>{todo.text}</div>
      ))}
      <button onClick={() => addTodo({ body: { text: "New todo" } })} disabled={addTodoLoading}>
        {addTodoLoading ? "Adding..." : "Add Todo"}
      </button>
    </div>
  );
}
```

## Fragment Development Quick Start

A Fragment is a full-stack library that works across different frameworks.

## Installation

```bash
bun add @fragno-dev/core
# or
npm install @fragno-dev/core
```

### 1. Create a Fragment (Library)

```typescript
// my-fragment/index.ts
import { defineFragment, defineRoute, createFragment } from "@fragno-dev/core";
import { createClientBuilder } from "@fragno-dev/core/client";
import { z } from "zod";
import OpenAI from "openai";

export interface FragmentConfig {
  // Any arguments the Fragment's user will have to pass. Could be callback methods, AI model, etc.
  openaiApiKey: string;
  onTodoCreated?: (todo: { id: string; text: string; done: boolean }) => void;
}

// Define your fragment
const todosDefinition = defineFragment<FragmentConfig>("example-fragment").withDependencies(
  (config: FragmentConfig) => {
    return {
      openaiClient: new OpenAI({
        apiKey: config.openaiApiKey,
      }),
    };
  },
);

// Define routes
const getTodosRoute = defineRoute({
  method: "GET",
  path: "/todos",
  // Accepts any StandardSchema object
  outputSchema: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      done: z.boolean(),
    }),
  ),
  handler: async (_, { json }) => {
    return json([]);
  },
});

const addTodoRoute = defineRoute({
  method: "POST",
  path: "/todos",
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({
    id: z.string(),
    text: z.string(),
    done: z.boolean(),
  }),
  handler: async ({ input }, { json }) => {
    const { text } = await input.valid();
    const todo = { id: crypto.randomUUID(), text, done: false };
    return json(todo);
  },
});

// Export server creator
export function createTodos(serverConfig: FragmentConfig = {}, fragnoConfig = {}) {
  return createFragment(todosDefinition, serverConfig, [getTodosRoute, addTodoRoute], fragnoConfig);
}

// Export type-safe client creator
export function createTodosClient(fragnoConfig = {}) {
  const builder = createClientBuilder(todosDefinition, fragnoConfig, [getTodosRoute, addTodoRoute]);

  return {
    useTodos: builder.createHook("/todos"),
    useAddTodo: builder.createMutator("POST", "/todos"),
  };
}
```

## Examples

The `examples/` directory contains complete examples of how to use Fragno with different frameworks
(React Router, Next.js, Nuxt, Astro, etc.).

There are also two examples showing the implementation of a Fragment (Fragno Library):

- `packages/example-fragment` - Minimal fragment example
- `packages/chatno` - Example fragment with OpenAI integration. Shows usage of config, dependencies,
  streaming, and advanced client-side state management.

## Contributing

Fragno is an open source project. We welcome contributions! Fragno is licensed under the MIT
License. See the [LICENSE](LICENSE.md) file for details.

See the [CONTRIBUTING](CONTRIBUTING.md) file for details.
