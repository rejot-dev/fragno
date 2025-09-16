<script lang="ts">
  import { derived, type Writable } from "svelte/store";
  import { onMount, onDestroy } from "svelte";
  import { createExampleFragmentClient } from "@fragno-dev/example-fragment";
  import { useFragno } from "@fragno-dev/core/svelte";

  export let refreshKey: Writable<string>;
  export let shouldTriggerError: Writable<boolean>;

  const exampleFragmentClient = createExampleFragmentClient();
  const { useData } = useFragno(exampleFragmentClient);

  const {
    loading,
    data,
    error: dataError,
  } = useData({
    query: {
      name: refreshKey,
      error: derived(shouldTriggerError, ($shouldTriggerError) =>
        $shouldTriggerError ? "true" : "",
      ),
    },
  });

  onMount(() => {
    console.log("DataDisplay Component mounted");
  });

  onDestroy(() => {
    console.log("DataDisplay Component destroyed");
  });
</script>

{#if $loading}
  <div class="loading">Loading…</div>
{:else if $dataError}
  <div class="error">
    Error: {$dataError.message} (code: {$dataError.code})
  </div>
{:else}
  <div class="data">
    {$data}
  </div>
{/if}

<style>
  .loading {
    padding: 15px;
    background-color: #f5f5f5;
    border-radius: 5px;
    border: 1px solid #ddd;
  }

  .error {
    padding: 15px;
    background-color: #f8d7da;
    border-radius: 5px;
    border: 1px solid #f5c6cb;
    color: #721c24;
  }

  .data {
    padding: 15px;
    background-color: #f5f5f5;
    border-radius: 5px;
    border: 1px solid #ddd;
  }
</style>
