# Stripe Webshop - TanStack Start Application

## Routing System

This app uses TanStack Start's file-based routing system.

### Page Routes

Routes are defined by creating files in `src/routes/`:

- `src/routes/index.tsx` → `/` (home page)
- `src/routes/about.tsx` → `/about`
- `src/routes/products/[id].tsx` → `/products/:id` (dynamic segment)

Each route file exports a `Route` created with `createFileRoute()`:

```tsx
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return <div>Hello World</div>;
}
```

### API Routes

API routes use the same file-based convention but define server handlers:

```tsx
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/todos")({
  server: {
    handlers: {
      GET: () => {
        return Response.json({ todos: [] });
      },
      POST: async ({ request }) => {
        const data = await request.json();
        return Response.json({ success: true });
      },
    },
  },
});
```

### Route Tree Generation

TanStack Router automatically generates `src/routeTree.gen.ts` based on your route files. This file
should not be edited manually and should be excluded from linting/formatting.

### Root Route

`src/routes/__root.tsx` defines the root layout that wraps all routes. It exports a
`MyRouterContext` interface that provides type-safe context (like `queryClient`) to all routes.

## shadcn instructions

Use the latest version of Shadcn to install new components, like this command to add a button
component:

```bash
pnpx shadcn@latest add button
```
