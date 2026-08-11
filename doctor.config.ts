export default {
  ignore: {
    rules: ["deslop/unused-dependency"],
    files: [
      // These helpers intentionally model unsafe or effect-driven behavior in tests.
      "src/testing/streamable-http-mcp-server.ts",
      "src/util/test-utils.tsx",
      // The scenario harness favors deterministic orchestration and exhaustive diagnostics.
      "app/fragno/automation/scenario.ts",
    ],
    overrides: [
      {
        // Stripe's shadcn components are integration fixtures imported by the JSON Forms tests.
        files: [
          "src/components/ui/calendar.tsx",
          "src/components/ui/checkbox.tsx",
          "src/components/ui/radio-group.tsx",
          "src/components/ui/select.tsx",
          "src/components/ui/slider.tsx",
          "src/components/ui/switch.tsx",
          "src/components/ui/tabs.tsx",
          "src/components/ui/textarea.tsx",
        ],
        rules: ["deslop/unused-file"],
      },
      {
        // Drizzle loads this schema through drizzle.config.ts rather than a source import.
        files: ["app/db/schema.ts"],
        rules: ["deslop/unused-file"],
      },
      {
        // Durable workflow operations stay sequential so step order and external effects are obvious.
        files: [
          "app/fragno/automation/marketplace-ingest-workflow.ts",
          "app/fragno/automation/marketplace-publish-workflow.ts",
        ],
        rules: ["react-doctor/async-await-in-loop"],
      },
      {
        // Authorization gates intentionally short-circuit in declaration order.
        files: ["app/backoffice-runtime/kernel.ts", "app/fragno/runtime-tools/runtime-tools.ts"],
        rules: ["react-doctor/async-await-in-loop"],
      },
      {
        // Upload configuration must commit before filesystem construction reads it.
        files: ["app/fragno/runtime-tools/families/internal.ts"],
        rules: ["react-doctor/server-sequential-independent-await"],
      },
      {
        // This test deliberately models the lossy JSON persistence boundary used by durable data.
        files: ["app/fragno/automation/scenario-pi-boundary.test.ts"],
        rules: ["react-doctor/no-json-parse-stringify-clone"],
      },
      {
        // React Router route modules must export loaders alongside their rendered route components.
        files: ["app/layouts/backoffice-layout.tsx"],
        rules: ["react-doctor/only-export-components"],
      },
    ],
  },
};
