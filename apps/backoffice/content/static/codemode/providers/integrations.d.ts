// integrations tools
type IntegrationsCodemodeProvider = {
  /** Discover available services and unconfigured services in the selected scope. Service availability does not prove live health. */
  discover(): Promise<IntegrationsDiscoverOutput>;
  /** List existing configured connections in the selected scope, one cursor page at a time. Deterministic IDs reuse source-owned identities; configuration does not imply live access. */
  list(input: IntegrationsListInput): Promise<IntegrationsListOutput>;
  /** Inspect source-owned connection configuration and available evidence without performing a live health check. The connection ID resolves only within the selected scope. */
  get(input: IntegrationsGetInput): Promise<IntegrationsGetOutput>;
  /** Read current requirements or submit input for a deterministic connection address. Setup is source-owned; this operation retains no attempt state or independent binding. Ready connections keep their configuration and credentials; reconfigure replaces them. */
  setup(input: IntegrationsSetupInput): Promise<IntegrationsSetupOutput>;
  /** Read replacement requirements or submit replacement configuration or credentials for an existing connection. Submission replaces source-owned state; continue with setup checks until ready. A missing connection needs setup. */
  reconfigure(input: IntegrationsReconfigureInput): Promise<IntegrationsReconfigureOutput>;
  /** Remove a connection's source-owned configuration and credentials in the selected scope. The address stays valid for a later setup. Requires confirm to repeat the connection ID. */
  disconnect(input: IntegrationsDisconnectInput): Promise<IntegrationsDisconnectOutput>;
  /** Discover the selected connection's supported actions and authoritative input/output contracts without executing them. Never infer schemas from action IDs. */
  actions(input: IntegrationsActionsInput): Promise<IntegrationsActionsOutput>;
  /** Execute an explicit connection action with JSON input/output, validated against its live contracts and service permissions. Binary inputs are schema-declared byte arrays; results retain the action's domain and asynchronous semantics. */
  execute(input: IntegrationsExecuteInput): Promise<IntegrationsExecuteOutput>;
  /** Perform explicit supported live checks without authorizing the connection or executing service actions. Return timestamped evidence, not blanket health or retained verification state. */
  verify(input: IntegrationsVerifyInput): Promise<IntegrationsVerifyOutput>;
};
declare const integrations: IntegrationsCodemodeProvider;

type IntegrationOverview = {
  id: IntegrationId;
  label: string;
  description: string;
  /** Singleton means one scoped configuration; multiple means separately selectable connections. Credentials remain in their existing service-owned stores. */
  connectionCardinality: "singleton" | "multiple";
  availability: IntegrationAvailability;
  /** Known named setup targets, including unconfigured fixed slots; never invented account or attempt IDs. */
  setupTargets: IntegrationConnectionSetupTarget[];
  /** Declared event identities do not prove live event delivery. */
  automationEvents: {
    source: string;
    eventType: string;
  }[];
};
type IntegrationId = string;
type IntegrationAvailability =
  | {
      status: "available";
    }
  | {
      status: "unavailable";
      reason: string;
    };
type IntegrationConnectionSetupTarget = {
  kind: "connection";
  connectionId: IntegrationConnectionId;
};
type IntegrationConnectionId = string;
type ConfiguredIntegrationConnection = {
  configuration: {
    status: "configured";
  };
  authorization: IntegrationAuthorizationStatus;
  /** Supported checks distinguish missing evidence from actual timestamped results; saved configuration alone proves no live health. */
  checks: IntegrationVerificationCheck[];
  nextSteps: string[];
  connectionId: IntegrationConnectionId;
  integrationId: IntegrationId;
  name: string;
};
type IntegrationAuthorizationStatus =
  | {
      status: "not-required";
    }
  | {
      status: "not-checked";
    }
  | {
      status: "missing";
    }
  | {
      /** Credentials or confirmed consent exist; this does not prove live service access. */
      status: "available";
    }
  | {
      status: "expired";
    };
type IntegrationVerificationCheck =
  | {
      id: string;
      label: string;
      status: "not-checked";
      reason: string;
    }
  | {
      id: string;
      label: string;
      status: "passed" | "failed";
      /** Time of the actual check, not configuration storage. */
      checkedAt: string;
      message: string;
    };
type IntegrationConnection = {
  configuration: IntegrationConfigurationStatus;
  authorization: IntegrationAuthorizationStatus;
  /** Supported checks distinguish missing evidence from actual timestamped results; saved configuration alone proves no live health. */
  checks: IntegrationVerificationCheck[];
  nextSteps: string[];
  connectionId: IntegrationConnectionId;
  integrationId: IntegrationId;
  name: string;
};
type IntegrationConfigurationStatus =
  | {
      status: "missing";
      missingFields: string[];
    }
  | {
      status: "configured";
    };
type IntegrationSetupProgress =
  | {
      connectionId: IntegrationConnectionId;
      status: "needs-input";
      instructions: string;
      inputSchema: IntegrationJsonSchema;
      /** Secret property names for input controls, never secret values. */
      secretFields: string[];
    }
  | {
      connectionId: IntegrationConnectionId;
      status: "needs-authorization";
      instructions: string;
      authorizationUrl: string;
    }
  | {
      connectionId: IntegrationConnectionId;
      status: "pending";
      message: string;
    }
  | {
      connectionId: IntegrationConnectionId;
      status: "ready";
    }
  | {
      connectionId: IntegrationConnectionId;
      status: "blocked";
      reason: string;
    }
  | {
      connectionId: IntegrationConnectionId;
      status: "expired";
      reason: string;
    };
type IntegrationJsonSchema =
  | boolean
  | {
      [key: string]: unknown;
    };
type IntegrationDisconnectResult = {
  connectionId: IntegrationConnectionId;
  /** Not-configured means nothing was stored at this address in the selected scope. */
  status: "disconnected" | "not-configured";
};
type IntegrationAction = {
  /** Action identity returned by actions for this connection. */
  id: string;
  label: string;
  description: string;
  inputSchema: IntegrationJsonSchema;
  /** Describes the action's own result, including any asynchronous job handle. */
  outputSchema: IntegrationJsonSchema;
};
type IntegrationsDiscoverOutput = IntegrationOverview[];
type IntegrationsListInput = {
  /** Null starts the scoped listing; use the returned next cursor. */
  cursor: string | null;
};
type IntegrationsListOutput = {
  connections: ConfiguredIntegrationConnection[];
  /** Null means all configured integrations in this scope have been listed. */
  cursor: string | null;
};
type IntegrationsGetInput = {
  connectionId: IntegrationConnectionId;
};
type IntegrationsGetOutput = IntegrationConnection;
type IntegrationsSetupInput =
  | {
      /** Read authoritative setup state; user confirmation is not proof of consent. */
      kind: "check";
      connectionId: IntegrationConnectionId;
    }
  | {
      kind: "input";
      /** Direct JSON setup input validated against the source's current requirements. Null is a submitted value, never a check sentinel. */
      input: JsonValue;
      connectionId: IntegrationConnectionId;
    };
type IntegrationsSetupOutput = IntegrationSetupProgress;
type IntegrationsReconfigureInput =
  | {
      /** Read authoritative setup state; user confirmation is not proof of consent. */
      kind: "check";
      connectionId: IntegrationConnectionId;
    }
  | {
      kind: "input";
      /** Direct JSON setup input validated against the source's current requirements. Null is a submitted value, never a check sentinel. */
      input: JsonValue;
      connectionId: IntegrationConnectionId;
    };
type IntegrationsReconfigureOutput = IntegrationSetupProgress;
type IntegrationsDisconnectInput = {
  connectionId: IntegrationConnectionId;
  /** Repeat connectionId to confirm removing its source-owned configuration and credentials. */
  confirm: IntegrationConnectionId;
};
type IntegrationsDisconnectOutput = IntegrationDisconnectResult;
type IntegrationsActionsInput = {
  connectionId: IntegrationConnectionId;
};
type IntegrationsActionsOutput = IntegrationAction[];
type IntegrationsExecuteInput = {
  connectionId: IntegrationConnectionId;
  actionId: string;
  /** JSON action input, validated against the live action schema before dispatch. Binary inputs use schema-declared byte arrays of integers 0–255, never ArrayBuffer or typed arrays; implementations convert them privately. */
  input: JsonValue;
};
type IntegrationsExecuteOutput = JsonValue;
type IntegrationsVerifyInput = {
  connectionId: IntegrationConnectionId;
};
type IntegrationsVerifyOutput = IntegrationConnection;
