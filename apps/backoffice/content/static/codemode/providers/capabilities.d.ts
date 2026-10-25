// Backoffice capabilities and whether each is configured. Read to check that a service is set up.
type CapabilitiesCodemodeProvider = {
  /** List Backoffice capabilities and availability/configuration status. */
  list(): Promise<CapabilitiesListOutput>;
};
declare const capabilities: CapabilitiesCodemodeProvider;

type CapabilitiesListOutput = {
  id: string;
  label: string;
  kind: "connection" | "system";
  available: boolean;
  configured: boolean;
  healthy?: boolean;
  reason?: string;
}[];
