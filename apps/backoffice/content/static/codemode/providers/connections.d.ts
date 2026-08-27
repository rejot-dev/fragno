// connections tools
type ConnectionsCodemodeProvider = {
  /** List configurable Backoffice connections and their configuration status. */
  list(input: ConnectionsListInput): Promise<ConnectionsListOutput>;
  /** Get one Backoffice connection status with masked configuration values. */
  get(input: ConnectionsGetInput): Promise<ConnectionsGetOutput>;
  /** Show human steps for configuring a Backoffice connection. */
  setup(input: ConnectionsSetupInput): Promise<ConnectionsSetupOutput>;
  /** Show the accepted configuration fields for a Backoffice connection. */
  schema(input: ConnectionsSchemaInput): Promise<ConnectionsSchemaOutput>;
  /** Verify a Backoffice connection without changing its configuration. */
  verify(input: ConnectionsVerifyInput): Promise<ConnectionsVerifyOutput>;
  /** Reset a Backoffice connection configuration. Requires --confirm <id>. */
  reset(input: ConnectionsResetInput): Promise<ConnectionsResetOutput>;
  /** Configure a Backoffice connection. Secrets are accepted in input but masked in output. */
  configure(input: ConnectionsConfigureInput): Promise<ConnectionsConfigureOutput>;
};
declare const connections: ConnectionsCodemodeProvider;

type ConnectionsListInput = Record<string, unknown>;
type ConnectionsListOutput = {
  id: string;
  label: string;
  kind: "connection" | "system";
  configured: boolean;
  hookScopes: string[];
  runtimeToolNamespaces: string[];
  automationEvents: string[];
  missing?: string[];
}[];
type ConnectionsGetInput = {
  id: string;
};
type ConnectionsGetOutput = {
  id: string;
  label: string;
  kind: "connection" | "system";
  configured: boolean;
  config?: {
    [key: string]: unknown;
  };
  missing?: string[];
  nextSteps?: string[];
  verification?: {
    ok: boolean;
    message: string;
  };
};
type ConnectionsSetupInput = {
  id: string;
};
type ConnectionsSetupOutput = {
  id: string;
  label: string;
  overview: string;
  manualSteps: {
    id: string;
    title: string;
    instructions: string;
    expectedUserInput?: string[];
  }[];
  fields: {
    name: string;
    required?: boolean;
    secret?: boolean;
    description?: string;
  }[];
  verify?: {
    tool: string;
    description: string;
  };
  configureExample: string;
};
type ConnectionsSchemaInput = {
  id: string;
};
type ConnectionsSchemaOutput = {
  id: string;
  label: string;
  fields: {
    name: string;
    required?: boolean;
    secret?: boolean;
    description?: string;
  }[];
};
type ConnectionsVerifyInput = {
  id: string;
};
type ConnectionsVerifyOutput = {
  id: string;
  label: string;
  kind: "connection" | "system";
  configured: boolean;
  config?: {
    [key: string]: unknown;
  };
  missing?: string[];
  nextSteps?: string[];
  verification: {
    ok: boolean;
    message: string;
  };
};
type ConnectionsResetInput = {
  id: string;
  confirm: string;
};
type ConnectionsResetOutput = {
  id: string;
  label: string;
  kind: "connection" | "system";
  configured: boolean;
  config?: {
    [key: string]: unknown;
  };
  missing?: string[];
  nextSteps?: string[];
  verification?: {
    ok: boolean;
    message: string;
  };
};
type ConnectionsConfigureInput = {
  id: string;
  payload: unknown;
  origin?: string;
};
type ConnectionsConfigureOutput = {
  id: string;
  label: string;
  kind: "connection" | "system";
  configured: boolean;
  config?: {
    [key: string]: unknown;
  };
  missing?: string[];
  nextSteps?: string[];
  verification?: {
    ok: boolean;
    message: string;
  };
};
