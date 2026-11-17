export declare const baseConfig: {
  test: {
    globals: boolean;
    silent: boolean;
    // Not Vitest's `Reporter`: packages resolve their own copy of Vitest, whose types differ.
    reporters: ["default", object];
    coverage: {
      provider: "istanbul";
      exclude: string[];
      reporter: [["json", { file: string }]];
      enabled: boolean;
    };
  };
  resolve: {
    conditions: string[];
  };
};
