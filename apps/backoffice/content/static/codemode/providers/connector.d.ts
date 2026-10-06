// connector tools
type ConnectorCodemodeProvider = {
  /** List the project's OAuth provider configuration overviews without action IDs. Use listProviderActions for a selected providerConfigId; discovery does not verify user accounts. */
  listProviderConfigs(): Promise<ConnectorListProviderConfigsOutput>;
  /** List authoritative action definitions, including input/output JSON Schemas, allowed by one exact OAuth provider configuration. Catalog discovery never grants execution permission. */
  listProviderActions(
    input: ConnectorListProviderActionsInput,
  ): Promise<ConnectorListProviderActionsOutput>;
  /** Check gateway project-key authentication, not individual provider availability. */
  check(): Promise<ConnectorCheckOutput>;
  /** Start provider OAuth for the owning user. Return the authorization URL and retain the request ID for refresh. */
  connect(input: ConnectorConnectInput): Promise<ConnectorConnectOutput>;
  /** Verify a saved OAuth request against the gateway and persist a confirmed account binding. Callback query parameters are not proof. */
  refreshConnection(
    input: ConnectorRefreshConnectionInput,
  ): Promise<ConnectorRefreshConnectionOutput>;
  /** List the owning user's locally verified accounts, one cursor page at a time. */
  listAccounts(input: ConnectorListAccountsInput): Promise<ConnectorListAccountsOutput>;
  /** Read the provider identity of a verified account; this does not read Gmail messages. */
  getProfile(input: ConnectorGetProfileInput): Promise<ConnectorGetProfileOutput>;
  /** Execute an explicit provider action on a verified account. Actions can write external data and are never automatically retried. */
  executeAction(input: ConnectorExecuteActionInput): Promise<ConnectorExecuteActionOutput>;
};
declare const connector: ConnectorCodemodeProvider;

type ConnectorListProviderConfigsOutput = {
  projectId: string;
  providerConfigs: {
    id: string;
    service: string;
    displayName: string;
    callbackUrl: string;
    effectiveScopes: string[];
    proxyAvailable: boolean;
  }[];
};
type ConnectorListProviderActionsInput = {
  providerConfigId: string;
};
type ConnectorListProviderActionsOutput = {
  projectId: string;
  providerConfigId: string;
  actions: {
    id: string;
    service: string;
    name: string;
    description: string | null;
    inputSchema: {
      [key: string]: unknown;
    };
    outputSchema: {
      [key: string]: unknown;
    };
  }[];
};
type ConnectorCheckOutput = {
  authenticated: true;
};
type ConnectorConnectInput =
  | {
      service: string;
      connectionName: string;
    }
  | {
      providerConfigId: string;
      connectionName: string;
    };
type ConnectorConnectOutput = {
  id: string;
  projectId: string;
  providerConfigId: string;
  externalUserId: string;
  service: string;
  connectionName: string | null;
  authorizationUrl: string;
  expiresAt: string;
  state:
    | {
        status: "initiated";
      }
    | {
        status: "connected";
        connectedAccountId: string;
      }
    | {
        status: "failed";
        errorCode: string | null;
        errorMessage: string | null;
      }
    | {
        status: "expired";
      };
};
type ConnectorRefreshConnectionInput = {
  requestId: string;
};
type ConnectorRefreshConnectionOutput = {
  id: string;
  projectId: string;
  providerConfigId: string;
  externalUserId: string;
  service: string;
  connectionName: string | null;
  authorizationUrl: string;
  expiresAt: string;
  state:
    | {
        status: "initiated";
      }
    | {
        status: "connected";
        connectedAccountId: string;
      }
    | {
        status: "failed";
        errorCode: string | null;
        errorMessage: string | null;
      }
    | {
        status: "expired";
      };
};
type ConnectorListAccountsInput = {
  cursor?: string | null;
};
type ConnectorListAccountsOutput = {
  accounts: {
    id: string;
    projectId: string;
    providerConfigId: string;
    externalUserId: string;
    service: string;
    connectionName: string | null;
  }[];
  cursor: string | null;
  hasNextPage: boolean;
};
type ConnectorGetProfileInput = {
  accountId: string;
};
type ConnectorGetProfileOutput = {
  connectedAccountId: string;
  externalUserId: string;
  service: string;
  profile: {
    id: string;
    kind: string;
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    email: string | null;
    metadata: {
      [key: string]: unknown;
    };
  };
  fetchedAt: number;
};
type ConnectorExecuteActionInput = {
  accountId: string;
  actionId: string;
  input: {
    [key: string]: unknown;
  };
};
type ConnectorExecuteActionOutput = {
  executionId: string;
  actionId: string;
  output: unknown;
};
