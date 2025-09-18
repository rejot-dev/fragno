<script lang="ts">
  import { createExampleFragmentClient } from "@fragno-dev/example-fragment";
  import { useFragno } from "@fragno-dev/core/svelte";
  let refreshKey = $state("hey");

  const exampleFragmentClient = createExampleFragmentClient();
  const { useData } = useFragno(exampleFragmentClient);

  const { loading, data, error } = useData({
    query: {
      name: () => refreshKey,
      error: () => "",
    },
  });

  const onclick = () => {
    refreshKey += "!";
  };
</script>

<svelte:head>
  <title>SvelteKit Fragno Runes</title>
</svelte:head>

<main>
  <h1>SvelteKit Fragno Runes</h1>
  {#if $loading}
    <div>Loading...</div>
  {:else if $error}
    <div>Error: {$error}</div>
  {:else}
    <div>{$data}</div>
  {/if}
  <button {onclick}>Refresh</button>
</main>
