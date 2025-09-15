# Fragno

**Framework-agnostic, type-safe full-stack TypeScript libraries**

Fragno enables you to build full-stack libraries (called "fragments") that work seamlessly across
different frameworks and environments. Write your API once, get type-safe clients for React, Vue,
and vanilla JavaScript automatically.

## Features

- 🔐 **End-to-end type safety** - From server to client, everything is typed
- 🎯 **Framework agnostic** - Works with React, Vue, Next.js, Nuxt, React Router, and more
- 📦 **Automatic code splitting** - Server code never reaches the client bundle
- 🚀 **Built-in state management** - Reactive stores with caching and optimistic updates
- 🌊 **Streaming support** - Real-time data with NDJSON (New-line Delimited JSON) streaming
- 🛠️ **Developer friendly** - Simple API, great TypeScript support

## Installation

```bash
bun add @fragno-dev/core
# or
npm install @fragno-dev/core
```

**Note:** When using Bun, install with `bun install --linker=isolated`

## Quick Start

### 1. Create a Fragment (Full-Stack Library)

```typescript
// my-fragment/index.ts
import { defineLibrary, defineRoute, createLibrary } from "@fragno-dev/core";
import { createClientBuilder } from "@fragno-dev/core/client";
import { z } from "zod";

// Define your library configuration
interface TodosServerConfig {
  // Add any server-specific configuration here
}

type TodosDeps = {
  todos: { id: string; text: string; done: boolean }[];
};

// Define your library
const todosDefinition = defineLibrary<TodosServerConfig>("todos").withDependencies(
  (config: TodosServerConfig) => {
    return {
      todos: [] as { id: string; text: string; done: boolean }[],
    };
  },
);

// Define routes
const getTodosRoute = defineRoute({
  method: "GET",
  path: "/todos",
  outputSchema: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      done: z.boolean(),
    }),
  ),
  handler: async (_, { json }) => {
    // In real implementation, access deps via route factory
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
    // In real implementation, access deps via route factory
    return json(todo);
  },
});

// Export server creator
export function createTodos(serverConfig: TodosServerConfig = {}, fragnoConfig = {}) {
  return createLibrary(todosDefinition, serverConfig, [getTodosRoute, addTodoRoute], fragnoConfig);
}

// Export type-safe client creator
export function createTodosClient(fragnoConfig = {}) {
  const builder = createClientBuilder(todosDefinition, fragnoConfig, [getTodosRoute, addTodoRoute]);

  return {
    useTodos: builder.createHook("/todos"),
    addTodo: builder.createMutator("POST", "/todos"),
  };
}
```

### 2. Use on the Server

#### Node.js / Express

```typescript
import { toNodeHandler } from "@fragno-dev/node";
import { createTodos } from "./my-fragment";

const todos = createTodos({}, { mountRoute: "/api/todos" });
app.use("/api/todos", toNodeHandler(todos.handler));
```

#### React Router

```typescript
// app/routes/api.todos.tsx
import { createTodos } from "./my-fragment";

export async function loader({ request }) {
  const todos = createTodos();
  return await todos.handler(request);
}

export async function action({ request }) {
  const todos = createTodos();
  return await todos.handler(request);
}
```

### 3. Use on the Client

#### React

```typescript
import { createTodosClient } from "./my-fragment";
import { useFragno } from "@fragno-dev/core/react";

const todosClient = createTodosClient({
  baseUrl: "http://localhost:3000",
  mountRoute: "/api/todos"
});

const { useTodos, addTodo } = useFragno(todosClient);

function TodoApp() {
  const { data: todos, loading } = useTodos();
  const { mutate: addTodo } = addTodo();

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      {todos?.map(todo => (
        <div key={todo.id}>{todo.text}</div>
      ))}
      <button onClick={() => addTodo({ body: { text: "New todo" } })}>
        Add Todo
      </button>
    </div>
  );
}
```

#### Vue

```typescript
import { createTodosClient } from "./my-fragment";
import { useFragno } from "@fragno-dev/core/vue";

const todosClient = createTodosClient({
  baseUrl: "http://localhost:3000",
  mountRoute: "/api/todos",
});

const { useTodos, addTodo } = useFragno(todosClient);

// In your component
const todos = useTodos();
const { mutate: addTodo } = addTodo();
```

## Code Splitting

Fragno automatically splits your code between client and server bundles using
`@fragno-dev/unplugin-fragno`:

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import fragno from "@fragno-dev/unplugin-fragno/vite";

export default defineConfig({
  plugins: [fragno()],
});
```

Server-side dependencies defined in `withDependencies` are automatically removed from client
bundles:

```typescript
// This entire dependencies factory is stripped from client bundles
const myLibDefinition = defineLibrary("my-lib").withDependencies((config) => {
  return {
    database: new DatabaseConnection(),
    secretKey: process.env.SECRET_KEY,
  };
});

// Client bundle only gets route definitions, not the server implementation
export function createMyLibrary(serverConfig = {}, fragnoConfig = {}) {
  return createLibrary(myLibDefinition, serverConfig, routes, fragnoConfig);
}
```

## Advanced Features

### Streaming Responses

```typescript
const streamRoute = defineRoute({
  method: "GET",
  path: "/stream",
  outputSchema: z.array(z.object({ message: z.string() })),
  handler: async (_, { jsonStream }) => {
    return jsonStream(async (stream) => {
      for (let i = 0; i < 10; i++) {
        await stream.write({ message: `Item ${i}` });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
  },
});
```

### Path Parameters

```typescript
const getUserRoute = defineRoute({
  method: "GET",
  path: "/users/:id",
  pathSchema: z.object({ id: z.string() }),
  handler: async ({ path }, { json }) => {
    const { id } = await path.valid();
    // Use typed id parameter
    return json({ userId: id });
  },
});
```

### Error Handling

```typescript
const protectedRoute = defineRoute({
  method: "POST",
  path: "/protected",
  errorCodes: ["UNAUTHORIZED", "FORBIDDEN"] as const,
  handler: async (_, { error, json }) => {
    if (!authorized) {
      return error(
        {
          message: "Login required",
          code: "UNAUTHORIZED",
        },
        401,
      );
    }
    return json({ success: true });
  },
});
```

### Middleware

Add middleware to intercept and process requests before they reach your route handlers:

```typescript
const library = defineLibrary<Config>("my-api").withServices((config) => ({
  auth: {
    isAuthorized: (token?: string) => token === config.apiKey,
  },
  logger: {
    log: (msg: string) => console.log(msg),
  },
}));

const instance = createLibrary(library, config, routes).withMiddleware(
  async (context, { deps, services }) => {
    const { method, path, queryParams, pathParams } = context;

    // Log request
    services.logger.log(`${method} ${path}`);

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Check authentication
    const authToken = queryParams.get("token");
    if (!services.auth.isAuthorized(authToken ?? undefined)) {
      return Response.json({ message: "Unauthorized", code: "AUTH_ERROR" }, { status: 401 });
    }

    // Route-specific middleware using ifMatchesRoute
    const result = await context.ifMatchesRoute("POST", "/users/:id", async ({ pathParams }) => {
      // This middleware only runs for POST requests to /users/:id

      // pathParams is strongly typed
      services.logger.log(`Creating user with ID: ${pathParams.id}`);

      // Return undefined to continue to the original handler
      return undefined;
    });

    if (result) {
      return result;
    }

    // Return undefined to continue to handler
    return undefined;
  },
);
```

Middleware receives:

- **`context`**: Request context with:
  - **`method`**: HTTP method
  - **`path`**: Request path
  - **`pathParams`**: Extracted path parameters
  - **`queryParams`**: URL search parameters
  - **`inputSchema`**: Route's input schema
  - **`outputSchema`**: Route's output schema
  - **`ifMatchesRoute()`**: Execute middleware only for specific routes with full type safety
- **`deps`**: Library dependencies
- **`services`**: Library services

The `ifMatchesRoute` method allows you to write route-specific middleware with full TypeScript
support for path parameters and request/response schemas.

Return a Response to short-circuit, or `undefined` to continue to the handler.

## Package Structure

- **`@fragno-dev/core`** - Core framework with React, Vue, and vanilla JS adapters
- **`@fragno-dev/node`** - Node.js server adapter
- **`@fragno-dev/unplugin-fragno`** - Build-time code splitting plugin
- **`packages/chatno`** - Example: AI chat fragment with OpenAI integration
- **`packages/example-fragment`** - Example: Minimal fragment implementation

## Examples

Check out the `examples/` directory for complete examples:

- `react-router-example` - React Router v7 integration
- `nextjs-example` - Next.js App Router
- `nuxt-example` - Nuxt 3 integration
- `astro-example` - Astro framework

## Why Fragno?

Traditional full-stack frameworks lock you into specific ecosystems. Fragno lets you build
**portable full-stack libraries** that work everywhere:

- **Library authors**: Build once, support all frameworks
- **App developers**: Use any fragment with your preferred framework
- **Teams**: Share full-stack features across different projects

## Contributing

We welcome contributions!

## License

MIT © ReJot and Fragno Contributors
