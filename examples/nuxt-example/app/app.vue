<template>
  <div style="padding: 20px; font-family: monospace; max-width: 800px; margin: 0 auto">
    <h1>Nuxt Fragno Example Fragment</h1>
    <p>Simple data reading with example-fragment</p>

    <div style="margin-bottom: 30px">
      <h2>Current Data</h2>
      <div
        v-if="dataRef.loading"
        style="padding: 15px; background-color: #f5f5f5; border-radius: 5px; border: 1px solid #ddd"
      >
        Loading…
      </div>
      <div
        v-else
        style="padding: 15px; background-color: #f5f5f5; border-radius: 5px; border: 1px solid #ddd"
      >
        {{ dataRef.data || "No data yet" }}
      </div>
    </div>

    <div style="margin-top: 30px; font-size: 14px; color: #666">
      <h3>Available Endpoints:</h3>
      <ul>
        <li>GET /api/example-fragment/ - Hello World</li>
        <li>GET /api/example-fragment/data - Retrieve current data</li>
        <li>POST /api/example-fragment/sample - Mutate data</li>
      </ul>
    </div>

    <div style="margin-top: 30px; font-size: 14px; color: #666">
      <button @click="handleClick">Click me to mutate data</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { createExampleFragmentClient } from "@rejot-dev/example-fragment";
import { useFragno } from "@rejot-dev/fragno/client/vue";
import { atom } from "nanostores";

const exampleFragmentClient = createExampleFragmentClient();
const { useData, useSampleMutator } = useFragno(exampleFragmentClient);

const refreshKey = atom("0");

const dataRef = useData({
  queryParams: {
    name: refreshKey,
  },
});

const handleClick = async () => {
  await useSampleMutator({ message: dataRef.value.data + "!" });
  refreshKey.set(String(Number(refreshKey.get()) + 1));
};
</script>
