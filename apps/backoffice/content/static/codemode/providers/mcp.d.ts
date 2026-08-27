// mcp tools
type McpCodemodeProvider = {
  /** List MCP servers configured for the current organization. */
  listServers(input: McpListServersInput): Promise<McpListServersOutput>;
  /** Register a remote streamable HTTP MCP server. */
  createServer(input: McpCreateServerInput): Promise<McpCreateServerOutput>;
  /** Delete an MCP server and its stored auth state. */
  deleteServer(input: McpDeleteServerInput): Promise<McpDeleteServerOutput>;
  /** Refresh a configured MCP server and update its cached tool list. */
  refreshServer(input: McpRefreshServerInput): Promise<McpRefreshServerOutput>;
  /** Call a tool exposed by a configured MCP server. */
  callTool(input: McpCallToolInput): Promise<McpCallToolOutput>;
  /** Start OAuth login for a configured MCP server and return the authorization URL. */
  startOAuth(input: McpStartOAuthInput): Promise<McpStartOAuthOutput>;
  /** Store a bearer token for a configured MCP server. */
  setToken(input: McpSetTokenInput): Promise<McpSetTokenOutput>;
};
declare const mcp: McpCodemodeProvider;

type McpListServersInput = Record<string, unknown>;
type McpListServersOutput = {
  servers: {
    slug: string;
    name?: string | null;
    endpointUrl: string;
    authMode: string;
    cache?: {
      protocolVersion?: string | null;
      serverInfo?: unknown | null;
      capabilities?: unknown | null;
      tools?:
        | {
            name: string;
            title?: string;
            description?: string;
            inputSchema?: {
              [key: string]: unknown;
            };
            annotations?: {
              [key: string]: unknown;
            };
            _meta?: {
              [key: string]: unknown;
            };
          }[]
        | null;
      updatedAt?: string;
    } | null;
  }[];
};
type McpCreateServerInput = {
  slug: string;
  name?: string;
  endpointUrl: string;
  auth?:
    | {
        type: "none";
      }
    | {
        type: "bearer";
        token: string;
      }
    | {
        type: "oauth";
        clientId?: string;
        clientSecret?: string;
        scopes?: string[];
      }
    | {
        type: "client_credentials";
        clientId: string;
        clientSecret: string;
        scopes?: string[];
      };
};
type McpCreateServerOutput = {
  slug: string;
  name?: string | null;
  endpointUrl: string;
  authMode: string;
  cache?: {
    protocolVersion?: string | null;
    serverInfo?: unknown | null;
    capabilities?: unknown | null;
    tools?:
      | {
          name: string;
          title?: string;
          description?: string;
          inputSchema?: {
            [key: string]: unknown;
          };
          annotations?: {
            [key: string]: unknown;
          };
          _meta?: {
            [key: string]: unknown;
          };
        }[]
      | null;
    updatedAt?: string;
  } | null;
};
type McpDeleteServerInput = {
  slug: string;
};
type McpDeleteServerOutput = {
  ok: true;
};
type McpRefreshServerInput = {
  slug: string;
};
type McpRefreshServerOutput = {
  ok: boolean;
  tools: {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: {
      [key: string]: unknown;
    };
    annotations?: {
      [key: string]: unknown;
    };
    _meta?: {
      [key: string]: unknown;
    };
  }[];
  stage: "auth" | "list_tools" | null;
  checkedAt: string;
  server: {
    slug: string;
    name?: string | null;
    endpointUrl: string;
    authMode: string;
  };
  auth: {
    authenticated: boolean;
    mode: string;
    tokenPresent: boolean;
    expiresAt: string | null;
    expired: boolean | null;
    scopes: {
      requested: string[] | null;
      granted: string[] | null;
      missing: string[] | null;
      raw: string | null;
    };
  };
  live: {
    reachable: boolean;
    listToolsOk: boolean;
    toolCount: number | null;
    protocolVersion: string | null;
    serverInfo: unknown | null;
    capabilities: unknown | null;
  };
  cache: {
    presentBeforeCheck: boolean;
    previousToolCount: number | null;
    updatedToolCount: number | null;
  };
  error: {
    code: string;
    message: string;
  } | null;
};
type McpCallToolInput = {
  slug: string;
  name: string;
  arguments?: {
    [key: string]: unknown;
  };
  timeoutMs?: number;
};
type McpCallToolOutput = {
  [key: string]: unknown;
};
type McpStartOAuthInput = {
  slug: string;
  scope?: string;
  clientId?: string;
  clientSecret?: string;
};
type McpStartOAuthOutput = {
  authorizationUrl: string;
  state: string;
};
type McpSetTokenInput = {
  slug: string;
  token: string;
};
type McpSetTokenOutput = {
  authenticated: boolean;
  mode: string;
};
