export default {
  ignore: {
    rules: ["deslop/unused-dependency"],
    files: [
      // Reliability smoke scripts are executable test artifacts, not package source.
      "workflows-smoke-artifacts/**",
      "**/workflows-smoke-artifacts/**",
      // These helpers intentionally model unsafe or effect-driven behavior in tests.
      "src/testing/streamable-http-mcp-server.ts",
      "src/util/test-utils.tsx",
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
    ],
  },
};
