<script lang="ts">
  import type { Readable } from "svelte/store";
  import { useFragno } from "./client.svelte";

  // oxlint-disable-next-line no-unassigned-vars
  export let clientObj: Record<string, unknown>;
  // oxlint-disable-next-line no-unassigned-vars
  export let hookName: string;
  export let args: Record<string, unknown> = {};

  const fragnoHooks = useFragno(clientObj);
  const hookResult = fragnoHooks[hookName](args);

  // Export hook results so they can be accessed from tests
  export const loading = hookResult.loading as Readable<boolean>;
  export const data = hookResult.data as Readable<unknown>;
  export const error = hookResult.error as Readable<Error | undefined>;
  export const mutate = hookResult.mutate as CallableFunction;
</script>

<div data-testid="test-component">
  Test Component - Hook: {hookName}
</div>
