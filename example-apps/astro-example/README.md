# Astro Fragno Example

This example demonstrates how to use Fragno with Astro, showing the integration between the Fragno
web framework and Astro's static site generation capabilities.

## Features

- **Server-side API routes** using Fragno's fragment system with Astro's native API route system
- **Client-side data fetching** with Fragno's Astro client
- **Real-time data mutations** with automatic refetching
- **Type-safe API interactions** using Zod schemas
- **SSR mode** enabled for dynamic API endpoints

## Available Endpoints

- `GET /api/example-fragment/` - Returns "Hello, world!"
- `GET /api/example-fragment/data` - Returns the current server-side data
- `POST /api/example-fragment/sample` - Updates the server-side data

## How it Works

1. **API Routes**: The `[...all].ts` file creates a catch-all route that handles all HTTP methods
   for the example-fragment API using Astro's native API route system
2. **Server-side Rendering**: Initial data is fetched on the server during SSR
3. **Client-side Interactivity**: JavaScript handles mutations and data refreshing
4. **Type Safety**: All API interactions are fully typed using the example-fragment schemas

## Setup

```bash
# Install dependencies
pnpm install

# Start development server
pnpm run dev

# Build for production
pnpm run build

# Preview production build
pnpm run preview
```

## Architecture

This example follows the same pattern as other Fragno examples:

- Uses the `example-fragment` package for the API implementation
- Leverages Fragno's fragment system directly with Astro's API routes
- Implements both server-side and client-side data handling
- Demonstrates the core + adapter pattern that Fragno promotes

## Key Differences from Other Examples

- **Astro-native API routes** using the `[...all].ts` pattern with exported HTTP method functions
- **SSR mode enabled** with the Node adapter for dynamic API endpoints
- **Hybrid rendering** with server-side data fetching and client-side mutations
- **Simplified client implementation** that works with Astro's component system

## Configuration

The example uses Astro's SSR mode with the Node adapter to enable dynamic API routes. This is
configured in `astro.config.mjs`:

```javascript
export default defineConfig({
  output: "server",
  adapter: node(),
});
```
