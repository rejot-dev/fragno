# Fragno

Fragno is the <ins>fr</ins>amework-<ins>agno</ins>stic toolkit for building full-stack TypeScript
libraries that work seamlessly across different frameworks such as Next.js, Nuxt, and
[way more](https://fragno.dev/docs/frameworks).

With Fragno:

- **Library authors** write API routes and client-side hooks as part of their library.
- **Users** integrate a library into their application in a couple lines of code. They can then
  immediately use library functionality from both the frontend and the backend.

A library built with Fragno is called a **Fragment**.

## Fragments

A **Fragment** is a full-stack **library** that:

- Contains both server-side API logic and client-side integration code
- Works across multiple frameworks (React, Vue, Next.js, Nuxt,
  [etc.](https://fragno.dev/docs/frameworks))
- Provides end-to-end functionality: type-safe & reactive

## Quick Start

Start building a full-stack library:

```bash
npm install @fragno-dev/core
# or
pnpm add @fragno-dev/core
```

Full documentation is available at [fragno.dev](https://fragno.dev/docs).

- If you're looking to build a Fragment, see the
  [For Library Authors](https://fragno.dev/docs/for-library-authors/getting-started) section.
- If you're looking to integrate a Fragment into your project, see the
  [User Quick Start](https://fragno.dev/docs/user-quick-start) section.

## Features

- 🔐 **End-to-end type safety**: routes are typed using Standard Schema and client-side hooks are
  fully type-safe
- 🚀 **Built-in state management**: reactive stores with caching built in (TanStack Query-style),
  using [Nano Stores](https://github.com/nanostores/nanostores)
- 🔄 **Middleware support**: Users can use middleware for custom request processing such as
  authentication.
- 🌊 **Streaming support**: Real-time data with NDJSON (New-line Delimited JSON) streaming
- 📦 **Automatic code splitting**: code is split on the library level, no added build complexity for
  end-users.

## Usage

### NextJS / Backend

As a user of a Fragment (library built w/ Fragno), you integrate with only a couple of lines of
code.

```typescript app/api/example-fragment/[...all]/route.ts
// app/api/example-fragment/[...all]/route.ts
import { createExampleFragment } from "@fragno-dev/example-fragment";

const exampleFragment = createExampleFragment({});
export const { GET, POST, PUT, PATCH, DELETE } = exampleFragment.handlersFor("next-js");
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
# Create from template
npm create fragno@latest
# or
pnpm create fragno@latest

# Add to existing package
npm install @fragno-dev/core
# or
pnpm add @fragno-dev/core
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

## Framework Support Matrix

| Client-side Frameworks | Support | —   | Server-side Frameworks  | Support |
| ---------------------- | ------- | --- | ----------------------- | ------- |
| React                  | ✅      |     | Node.js / Express       | ✅      |
| Vue                    | ✅      |     | React Router v7 / Remix | ✅      |
| Vanilla JavaScript     | ✅      |     | Astro                   | ✅      |
| Svelte                 | ✅      |     | Next.js                 | ✅      |
| SolidJS                | ✅      |     | Nuxt                    | ✅      |
|                        |         |     | SvelteKit               | ✅      |
|                        |         |     | SolidStart              | ✅      |
|                        |         |     | TanStack Start          | ✅      |

See the [Framework Support](https://fragno.dev/docs/frameworks) page for the full list of supported
frameworks.

## Examples

The `example-apps` directory contains complete examples of how to use Fragno with different
frameworks (React Router, Next.js, Nuxt, Astro, etc.).

There are also two examples showing the implementation of a Fragment (Fragno Library):

- `example-fragments/example-fragment` - Minimal fragment example
- `example-fragments/chatno` - Example fragment with OpenAI integration. Shows usage of config,
  dependencies, streaming, and advanced client-side state management.

## Contributing

Fragno is an open source project. We welcome contributions! Fragno is licensed under the MIT
License. See the [LICENSE](LICENSE.md) file for details.

See the [CONTRIBUTING](CONTRIBUTING.md) file for details.
