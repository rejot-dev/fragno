export const AUTOMATION_SCRIPT_ENGINES = {
  bash: "bash",
  codemode: "codemode",
  codemodeWorkflow: "codemode-workflow",
} as const;

export type AutomationScriptEngine =
  (typeof AUTOMATION_SCRIPT_ENGINES)[keyof typeof AUTOMATION_SCRIPT_ENGINES];
