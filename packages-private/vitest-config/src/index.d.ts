export declare const baseConfig: {
  test: {
    globals: boolean;
    silent: boolean;
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
