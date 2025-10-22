<script lang="ts">
  import { writable } from "svelte/store";
  import DataDisplay from "$lib/components/DataDisplay.svelte";

  import { createExampleFragmentClient } from "@fragno-dev/example-fragment/svelte";

  const { useHash, useSampleMutator } = createExampleFragmentClient();

  const refreshKey = writable("hey");
  const shouldTriggerError = writable(false);
  const shouldShowComponent = writable(true);

  const { loading: hashLoading, data: hashData, error: hashError } = useHash();

  // Mutator for sending messages
  const {
    mutate: sampleMutate,
    loading: sampleMutateLoading,
    error: sampleMutateError,
    data: sampleMutateData,
  } = useSampleMutator();
  const messageInput = writable("");

  async function sendMessage() {
    const message = $messageInput;
    if (!message.trim()) {
      return;
    }
    await sampleMutate({
      body: { message },
    });
    // Clear input and refresh data after successful mutation
    messageInput.set("");
    refreshKey.update((n) => n + "!");
  }
</script>

<svelte:head>
  <title>SvelteKit Fragno Example Fragment</title>
</svelte:head>

<main>
  <div style="margin-bottom: 30px">
    <h1>SvelteKit Fragno Example</h1>
    <a href="/runes">See example using Runes</a>.
    <h2>Current Data:</h2>
    <input
      id="toggle-data"
      type="checkbox"
      bind:checked={$shouldShowComponent}
      style="margin-right: 6px"
    />
    <label for="toggle-data" style="font-size: 14px; color: #333"> Show Data </label>
    {#if $shouldShowComponent}
      <DataDisplay {refreshKey} {shouldTriggerError} />
    {/if}
    <div style="margin-top: 15px; display: flex; align-items: center; gap: 8px">
      <input
        id="toggle-error"
        type="checkbox"
        bind:checked={$shouldTriggerError}
        style="margin-right: 6px"
      />
      <label for="toggle-error" style="font-size: 14px; color: #333"> Trigger error </label>
    </div>
  </div>

  <div style="margin-bottom: 30px">
    <div style="margin-bottom: 30px">
      <h2>Send Message:</h2>
      <div style="display: flex; gap: 10px; margin-bottom: 15px">
        <input
          bind:value={$messageInput}
          placeholder="Enter your message..."
          disabled={$sampleMutateLoading}
          style="flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 4px"
        />
        <button
          onclick={sendMessage}
          disabled={$sampleMutateLoading || !$messageInput.trim()}
          style="padding: 8px 16px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer"
        >
          {$sampleMutateLoading ? "Sending..." : "Send Message"}
        </button>
      </div>

      {#if $sampleMutateError}
        <div class="error">
          Mutation error: {$sampleMutateError.message} (code: {$sampleMutateError.code})
        </div>
      {/if}

      {#if $sampleMutateData}
        <div class="success">
          Message sent: {$sampleMutateData}
        </div>
      {/if}
    </div>
    <h2>Hash Data:</h2>
    {#if $hashLoading}
      <div class="loading">Loading hash…</div>
    {:else if $hashError}
      <div class="error">
        Hash error: {$hashError.message} (code: {$hashError.code})
      </div>
    {:else}
      <div class="data">
        {$hashData || "No hash data"}
      </div>
    {/if}
  </div>
</main>

<style>
  main {
    padding: 20px;
    font-family:
      system-ui,
      -apple-system,
      sans-serif;
  }

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

  .success {
    padding: 15px;
    background-color: #d4edda;
    border-radius: 5px;
    border: 1px solid #c3e6cb;
    color: #155724;
  }
</style>
