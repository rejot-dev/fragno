<template>
  <div style="padding: 20px; font-family: monospace; max-width: 800px; margin: 0 auto">
    <h1>Nuxt Fragno Example Fragment</h1>
    <p>Simple data reading with example-fragment</p>

    <div style="margin-bottom: 30px">
      <h2>Current Data</h2>
      <div
        v-if="loading"
        style="padding: 15px; background-color: #f5f5f5; border-radius: 5px; border: 1px solid #ddd"
      >
        Loading…
      </div>
      <div
        v-else-if="dataError"
        style="
          padding: 15px;
          background-color: #f8d7da;
          border-radius: 5px;
          border: 1px solid #f5c6cb;
          color: #721c24;
        "
      >
        Error: {{ dataError.message }} (code: {{ dataError.code }})
      </div>
      <div
        v-else
        style="padding: 15px; background-color: #f5f5f5; border-radius: 5px; border: 1px solid #ddd"
      >
        {{ data || "No data yet" }}
      </div>
      <div style="margin-top: 15px; display: flex; align-items: center; gap: 8px">
        <input
          id="toggle-error"
          type="checkbox"
          v-model="shouldTriggerError"
          style="margin-right: 6px"
        />
        <label for="toggle-error" style="font-size: 14px; color: #333"> Trigger error </label>
      </div>
    </div>

    <div style="margin-top: 30px; font-size: 14px; color: #666">
      <h3>Available Endpoints:</h3>
      <ul>
        <li>GET /api/example-fragment/hello - Hello World</li>
        <li>GET /api/example-fragment/data - Retrieve current data</li>
        <li>POST /api/example-fragment/sample - Mutate data</li>
      </ul>
    </div>

    <div style="margin-top: 30px; font-size: 14px; color: #666; display: flex; gap: 10px">
      <button @click="handleClick" :disabled="sampleMutateLoading">
        {{ sampleMutateLoading ? "Saving..." : "Click me to mutate data" }}
      </button>
      <button @click="handleClickError" :disabled="sampleMutateLoading">
        {{ sampleMutateLoading ? "Saving..." : "Click me to mutate data with error" }}
      </button>
    </div>

    <div
      v-if="sampleMutateData"
      style="
        margin-top: 15px;
        padding: 10px;
        background-color: #d4edda;
        border: 1px solid #c3e6cb;
        border-radius: 5px;
      "
    >
      <p>Success! Data: {{ sampleMutateData }}</p>
    </div>

    <div
      v-if="sampleMutateError"
      style="
        margin-top: 15px;
        padding: 10px;
        background-color: #f8d7da;
        border: 1px solid #f5c6cb;
        border-radius: 5px;
      "
    >
      <p>Error: {{ sampleMutateError.message }} (code: {{ sampleMutateError.code }})</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { createExampleFragmentClient } from "@fragno-dev/example-fragment";
import { useFragno } from "@fragno-dev/core/vue";
import { ref } from "vue";

const exampleFragmentClient = createExampleFragmentClient();
const { useData, useSampleMutator } = useFragno(exampleFragmentClient);

const refreshKey = ref(0);
const shouldTriggerError = ref(false);

const {
  loading,
  data,
  error: dataError,
} = useData({
  query: {
    name: computed(() => refreshKey.value.toString()),
    error: computed(() => (shouldTriggerError.value ? "true" : "")),
  },
});

const {
  mutate: sampleMutate,
  loading: sampleMutateLoading,
  error: sampleMutateError,
  data: sampleMutateData,
} = useSampleMutator();

const handleClick = async () => {
  await sampleMutate({
    body: { message: data.value + "!" },
  });
  refreshKey.value++;
};

const handleClickError = async () => {
  await sampleMutate({
    body: { message: "123" },
  });
};
</script>
