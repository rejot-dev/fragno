# Client Integration

## Create Client-Side Integration

Create the client-side integration in a central location. Import the client creator from the
fragment's **framework-specific export** (e.g., `/react`, `/vue`, `/svelte`, `/solid`, `/vanilla`).

If the backend routes are mounted on a non-default path, pass `mountRoute` to the client creator:

```typescript
export const exampleFragment = createExampleFragmentClient({
  mountRoute: "/custom/api/example-fragment",
});
```

**Important:** Do NOT name the file with a `.client.ts` suffix, as some frameworks treat it as
client-only and it won't be available during SSR.

### React

```typescript
// lib/example-fragment-client.ts
import { createExampleFragmentClient } from "@fragno-dev/example-fragment/react";

export const exampleFragment = createExampleFragmentClient();
```

### Vue

```typescript
// lib/example-fragment-client.ts (or utils/example-fragment.ts in Nuxt)
import { createExampleFragmentClient } from "@fragno-dev/example-fragment/vue";

export const exampleFragment = createExampleFragmentClient();
```

### Svelte

```typescript
// lib/example-fragment-client.ts
import { createExampleFragmentClient } from "@fragno-dev/example-fragment/svelte";

export const exampleFragment = createExampleFragmentClient();
```

### SolidJS

```typescript
// lib/example-fragment-client.ts
import { createExampleFragmentClient } from "@fragno-dev/example-fragment/solid";

export const exampleFragment = createExampleFragmentClient();
```

### Vanilla JavaScript

```typescript
// lib/example-fragment-client.ts
import { createExampleFragmentClient } from "@fragno-dev/example-fragment/vanilla";

export const exampleFragment = createExampleFragmentClient();
```

## Client-Side Usage

Use the Fragment hooks/composables in your UI components:

### React

```typescript
// components/ExampleComponent.tsx
import { exampleFragment } from "@/lib/example-fragment-client";

export default function ExampleComponent() {
  const { data, loading } = exampleFragment.useData();

  return (
    <div>
      <h1>Example Component</h1>
      {loading ? <div>Loading...</div> : <div>{data}</div>}
    </div>
  );
}
```

### Vue

```vue
<!-- components/ExampleComponent.vue -->
<template>
  <div>
    <div v-if="loading">Loading...</div>
    <div v-else>{{ data }}</div>
  </div>
</template>

<script setup lang="ts">
import { exampleFragment } from "@/lib/example-fragment-client";

const { data, loading } = exampleFragment.useData();
</script>
```

### Svelte

```svelte
<!-- components/ExampleComponent.svelte -->
<script lang="ts">
  import { exampleFragment } from "@/lib/example-fragment-client";

  const { data, loading } = exampleFragment.useData();
</script>

<div>
  {#if $loading}
    <div>Loading…</div>
  {:else}
    <div>{$data}</div>
  {/if}
</div>
```

### SolidJS

```typescript
// components/ExampleComponent.tsx
import { exampleFragment } from "@/lib/example-fragment-client";
import { Show } from "solid-js";

export default function ExampleComponent() {
  const { data, loading } = exampleFragment.useData();
  return (
    <div>
      <Show when={loading()}>
        <div>Loading...</div>
      </Show>

      <Show when={data()}>
        <div>{data()}</div>
      </Show>
    </div>
  );
}
```

### Vanilla JavaScript

```typescript
// main.ts
import { exampleFragment } from "@/lib/example-fragment-client";

exampleFragment.useData().subscribe(({ data, loading }) => {
  const dataDisplay = document.getElementById("data-display")!;
  dataDisplay.textContent = loading ? "loading..." : data;
});
```
