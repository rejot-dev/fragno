// capabilities tools
type CapabilitiesCodemodeProvider = {
  /** List Backoffice capabilities and availability/configuration status. */
  list(input: CapabilitiesListInput): Promise<CapabilitiesListOutput>;
};
declare const capabilities: CapabilitiesCodemodeProvider;

type CapabilitiesListInput = Record<string, unknown>;
type CapabilitiesListOutput = {
  id: string;
  label: string;
  kind: "connection" | "system";
  available: boolean;
  configured: boolean;
  healthy?: boolean;
  reason?: string;
}[];
