/**
 * Categories built-in services share with the Connector catalog, using its IDs and labels so that
 * built-in and Connector services group together.
 */
export const INTEGRATION_CATEGORY = {
  ai: { id: "ai", label: "AI" },
  communication: { id: "communication", label: "Communication" },
  developerTools: { id: "developer_tools", label: "Developer Tools" },
  productivity: { id: "productivity", label: "Productivity" },
} as const;
