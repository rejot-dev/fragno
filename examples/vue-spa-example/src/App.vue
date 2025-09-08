<script setup lang="ts">
import { createExampleFragmentClient } from "@fragno-dev/example-fragment";
import { useFragno } from "@fragno-dev/core/vue";
import { ref, computed } from "vue";

const exampleFragmentClient = createExampleFragmentClient();
const { useData } = useFragno(exampleFragmentClient);

const refreshKey = ref(0);
const shouldTriggerError = ref(false);

const {
  loading,
  data,
  error: dataError,
} = useData(undefined, {
  name: computed(() => refreshKey.value.toString()),
  error: computed(() => (shouldTriggerError.value ? "true" : "")),
});
</script>

<template>
  <div style="margin-bottom: 30px">
    <h1>Vue SPA Example</h1>
    <h2>Current Data:</h2>
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
</template>

<style scoped></style>
