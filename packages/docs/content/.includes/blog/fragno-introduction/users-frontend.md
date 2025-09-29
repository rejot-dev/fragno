```ts title="lib/example-fragment-client.ts" tab="React"
import { createExampleFragmentClient } from "@fragno-dev/example-fragment";
import { useFragno } from "@fragno-dev/core/react";

const exampleFragmentClient = createExampleFragmentClient();
export const exampleFragment = useFragno(exampleFragmentClient);
```

```ts title="lib/example-fragment-client.ts" tab="Vue"
import { createExampleFragmentClient } from "@fragno-dev/example-fragment";
import { useFragno } from "@fragno-dev/core/vue";

const exampleFragmentClient = createExampleFragmentClient();
export const exampleFragment = useFragno(exampleFragmentClient);
```

```ts title="lib/example-fragment-client.ts" tab="Svelte"
import { createExampleFragmentClient } from "@fragno-dev/example-fragment";
import { useFragno } from "@fragno-dev/core/svelte";

const exampleFragmentClient = createExampleFragmentClient();
export const exampleFragment = useFragno(exampleFragmentClient);
```

```ts title="lib/example-fragment-client.ts" tab="Vanilla JavaScript"
import { createExampleFragmentClient } from "@fragno-dev/example-fragment";
import { useFragno } from "@fragno-dev/core/vanilla";

const exampleFragmentClient = createExampleFragmentClient();
export const exampleFragment = useFragno(exampleFragmentClient);
```
