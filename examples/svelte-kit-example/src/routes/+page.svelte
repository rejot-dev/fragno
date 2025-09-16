<script lang="ts">
  import { writable } from "svelte/store";
  import DataDisplay from "$lib/components/DataDisplay.svelte";

  import { createExampleFragmentClient } from "@fragno-dev/example-fragment";
  import { useFragno } from "@fragno-dev/core/svelte";

  const exampleFragmentClient = createExampleFragmentClient();
  const { useData } = useFragno(exampleFragmentClient);

  const refreshKey = writable("hey");
  const shouldTriggerError = writable(false);


  const { loading, data, error } = useData({
    query: {
      name: derived(refreshKey, ($refreshKey) => $refreshKey.toString()),
      error: derived(shouldTriggerError, ($shouldTriggerError) =>
        $shouldTriggerError ? "true" : "",
      ),
    },
  });
</script>

<svelte:head>
  <title>SvelteKit Fragno Example Fragment</title>
</svelte:head>

<main>
  <section class="stack">
    <h1>SvelteKit Fragno Example Fragment</h1>
    <p>Simple data reading with example-fragment.</p>

    {#if $loading}
      <p class="muted">Loading hash…</p>
    {:else if $error}
      <p class="error">Hash error: {$error.message}</p>
    {:else}
      <p class="hash">{$data}</p>
    {/if}

  </section>
</main>

<style>
  main {
    font-family: "Fira Code", ui-monospace, SFMono-Regular, SFMono, Menlo, Monaco, Consolas,
      "Liberation Mono", "Courier New", monospace;
    min-height: 100vh;
    background: #0f172a;
    color: #e2e8f0;
    display: flex;
    justify-content: center;
    padding: 3rem 1.5rem;
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    max-width: 740px;
    width: 100%;
  }

  .muted {
    color: #94a3b8;
  }

  .error {
    color: #fecaca;
  }

  .hash {
    font-size: 0.9rem;
    word-break: break-all;
    background: rgba(15, 118, 110, 0.15);
    border: 1px solid rgba(45, 212, 191, 0.4);
    padding: 0.75rem;
    border-radius: 0.6rem;
  }
</style>
