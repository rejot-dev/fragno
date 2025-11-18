# Client-side State Management

Client-side state management in Fragno uses Nanostores under the hood, providing reactive stores
that integrate with React, Vue, Svelte, and vanilla JavaScript. The `ClientBuilder` class creates
hooks and mutators for your routes.

```typescript @fragno-imports
import { defineFragment, defineRoute, defineRoutes } from "@fragno-dev/core";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createClientBuilder } from "@fragno-dev/core/client";
import { computed } from "nanostores";
import { z } from "zod";
```

```typescript @fragno-prelude:fragment-setup
interface TodoConfig {
  apiUrl: string;
}

const todoFragment = defineFragment<TodoConfig>("todos");

const routes = defineRoutes(todoFragment).create(({ defineRoute }) => [
  defineRoute({
    method: "GET",
    path: "/todos",
    outputSchema: z.array(z.object({ id: z.string(), text: z.string(), completed: z.boolean() })),
    handler: async (_, { json }) => json([]),
  }),
  defineRoute({
    method: "POST",
    path: "/todos",
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({ id: z.string(), text: z.string(), completed: z.boolean() }),
    handler: async ({ input }, { json }) => {
      const data = await input.valid();
      return json({ id: "todo-1", text: data.text, completed: false });
    },
  }),
  defineRoute({
    method: "PUT",
    path: "/todos/:id",
    inputSchema: z.object({ completed: z.boolean() }),
    outputSchema: z.object({ id: z.string(), text: z.string(), completed: z.boolean() }),
    handler: async ({ input }, { json }) => {
      const data = await input.valid();
      return json({ id: "todo-1", text: "Updated todo", completed: data.completed });
    },
  }),
  defineRoute({
    method: "DELETE",
    path: "/todos/:id",
    outputSchema: z.object({ success: z.boolean() }),
    handler: async (_, { json }) => json({ success: true }),
  }),
  defineRoute({
    method: "POST",
    path: "/chat/stream",
    inputSchema: z.object({
      messages: z.array(z.object({ role: z.string(), content: z.string() })),
    }),
    outputSchema: z.array(z.object({ type: z.string(), delta: z.string().optional() })),
    handler: async (_, { jsonStream }) =>
      jsonStream(async (stream) => {
        stream.write({ type: "response.output_text.delta", delta: "Hello" });
        stream.write({ type: "response.output_text.delta", delta: " World" });
      }),
  }),
]);
```

## Basic ClientBuilder Setup

Create a client builder and export hooks for your fragment's routes.

```typescript @fragno-test:basic-client-builder
// should create a basic client builder
export function createTodoClient(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(todoFragment, fragnoConfig, [routes]);

  return {
    useTodos: builder.createHook("/todos"),
  };
}

const client = createTodoClient();
expect(client.useTodos).toBeDefined();
```

## Reading Data with createHook

Create read-only query hooks for GET routes.

```typescript @fragno-test:create-hook
// should create a hook for GET routes
export function createTodoClient(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(todoFragment, fragnoConfig, [routes]);

  return {
    useTodos: builder.createHook("/todos"),
  };
}

const client = createTodoClient();
const hook = client.useTodos;

// Hook has store and query methods
expect(hook.store).toBeDefined();
expect(hook.query).toBeDefined();
```

Users call the hook with path and query parameters. The hook returns `data`, `loading`, and `error`
properties that are reactive.

## Mutating Data with createMutator

Create mutators for POST, PUT, DELETE routes. Returns `data`, `loading`, `error`, and a `mutate`
function.

```typescript @fragno-test:create-mutator
// should create mutators for POST/PUT/DELETE routes
export function createTodoClient(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(todoFragment, fragnoConfig, [routes]);

  return {
    useTodos: builder.createHook("/todos"),
    useCreateTodo: builder.createMutator("POST", "/todos"),
    useUpdateTodo: builder.createMutator("PUT", "/todos/:id"),
    useDeleteTodo: builder.createMutator("DELETE", "/todos/:id"),
  };
}

const client = createTodoClient();
expect(client.useCreateTodo.mutatorStore).toBeDefined();
expect(client.useUpdateTodo.mutatorStore).toBeDefined();
expect(client.useDeleteTodo.mutatorStore).toBeDefined();
```

## Custom Invalidation

By default, mutations invalidate the same route. Use `onInvalidate` to invalidate other routes.

```typescript @fragno-test:custom-invalidation
// should invalidate other routes on mutation
export function createTodoClient(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(todoFragment, fragnoConfig, [routes]);

  return {
    useTodos: builder.createHook("/todos"),
    useCreateTodo: builder.createMutator("POST", "/todos", (invalidate) => {
      invalidate("GET", "/todos", {});
    }),
    useUpdateTodo: builder.createMutator("PUT", "/todos/:id", (invalidate, params) => {
      invalidate("GET", "/todos", {});
    }),
    useDeleteTodo: builder.createMutator("DELETE", "/todos/:id", (invalidate, params) => {
      invalidate("GET", "/todos", {});
    }),
  };
}

const client = createTodoClient();
expect(client.useCreateTodo.mutatorStore).toBeDefined();
```

## Derived Data with Nanostores

Use `computed` to create derived stores. Must wrap with `builder.createStore` for framework
reactivity.

```typescript @fragno-test:derived-data
// should create derived stores from mutator data
export function createChatClient(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(todoFragment, fragnoConfig, [routes]);

  const chatStream = builder.createMutator("POST", "/chat/stream");

  const aggregatedMessage = computed(chatStream.mutatorStore, ({ data }) => {
    return (data ?? [])
      .filter((item) => item.type === "response.output_text.delta")
      .map((item) => item.delta)
      .join("");
  });

  return {
    useChatStream: chatStream,
    useAggregatedMessage: builder.createStore(aggregatedMessage),
  };
}

const client = createChatClient();
expect(client.useAggregatedMessage).toBeDefined();
```

## Arbitrary Values and Custom Functions

Wrap custom objects with `builder.createStore` to make properties reactive. Functions remain
unchanged.

```typescript @fragno-test:arbitrary-values
// should wrap custom objects and functions
export function createChatClient(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(todoFragment, fragnoConfig, [routes]);

  const chatStream = builder.createMutator("POST", "/chat/stream");

  const aggregatedMessage = computed(chatStream.mutatorStore, ({ data }) => {
    return (data ?? []).map((item) => item.delta).join("");
  });

  function sendMessage(message: string) {
    chatStream.mutatorStore.mutate({
      body: {
        messages: [{ role: "user", content: message }],
      },
    });
  }

  return {
    useSendMessage: builder.createStore({
      response: aggregatedMessage,
      responseLoading: computed(chatStream.mutatorStore, ({ loading }) => loading),
      sendMessage,
    }),
  };
}

const client = createChatClient();
expect(client.useSendMessage).toBeDefined();
```

Only top-level properties are made reactive. Deeply nested keys are not transformed.

## Custom Fetcher Configuration

Set default fetch options or provide a custom fetch function.

```typescript @fragno-test:custom-fetcher-options
// should set custom fetch options
export function createTodoClient(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(todoFragment, fragnoConfig, [routes], {
    type: "options",
    options: { credentials: "include" },
  });

  return {
    useTodos: builder.createHook("/todos"),
  };
}

const client = createTodoClient();
expect(client.useTodos).toBeDefined();
```

```typescript @fragno-test:custom-fetch-function
// should provide custom fetch function
const customFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
  return fetch(url, { ...init, headers: { ...init?.headers, "X-Custom": "header" } });
};

export function createTodoClient(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(todoFragment, fragnoConfig, [routes], {
    type: "function",
    fetcher: customFetch,
  });

  return {
    useTodos: builder.createHook("/todos"),
  };
}

const client = createTodoClient();
expect(client.useTodos).toBeDefined();
```

User configuration takes precedence: custom fetch functions override everything, RequestInit options
deep merge with user values winning conflicts.

## Custom Backend Calls

Use `buildUrl()` and `getFetcher()` for requests beyond `createHook`/`createMutator`.

```typescript @fragno-test:custom-backend-calls
// should build URLs and get fetcher for custom calls
export function createTodoClient(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(todoFragment, fragnoConfig, [routes]);

  async function customCall(userId: string) {
    const { fetcher, defaultOptions } = builder.getFetcher();
    const url = builder.buildUrl("/todos/:id", { path: { id: userId } });
    return fetcher(url, { ...defaultOptions, method: "GET" }).then((r) => r.json());
  }

  return {
    useTodos: builder.createHook("/todos"),
    customCall,
  };
}

const client = createTodoClient();
expect(client.customCall).toBeDefined();
```
