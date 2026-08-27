// api tools
type ApiCodemodeProvider = {
  /** List API connections configured for the current scope. */
  listConnections(input: ApiListConnectionsInput): Promise<ApiListConnectionsOutput>;
  /** Create an outbound HTTP API connection. */
  createConnection(input: ApiCreateConnectionInput): Promise<ApiCreateConnectionOutput>;
  /** Delete an API connection and its stored auth state. */
  deleteConnection(input: ApiDeleteConnectionInput): Promise<ApiDeleteConnectionOutput>;
  /** Read auth status for an API connection. */
  getAuthStatus(input: ApiGetAuthStatusInput): Promise<ApiGetAuthStatusOutput>;
  /** Store a bearer token for a configured API connection. */
  setToken(input: ApiSetTokenInput): Promise<ApiSetTokenOutput>;
  /** Start OAuth login for a configured API connection and return the authorization URL. */
  startOAuth(input: ApiStartOAuthInput): Promise<ApiStartOAuthOutput>;
  /** Delete stored auth for an API connection. */
  deleteAuth(input: ApiDeleteAuthInput): Promise<ApiDeleteAuthOutput>;
  /** List API webhook endpoints configured for the current scope. */
  listWebhookEndpoints(input: ApiListWebhookEndpointsInput): Promise<ApiListWebhookEndpointsOutput>;
  /** Read an API webhook endpoint. */
  getWebhookEndpoint(input: ApiGetWebhookEndpointInput): Promise<ApiGetWebhookEndpointOutput>;
  /** Create or replace an API webhook endpoint. */
  createWebhookEndpoint(
    input: ApiCreateWebhookEndpointInput,
  ): Promise<ApiCreateWebhookEndpointOutput>;
  /** Update an API webhook endpoint. */
  updateWebhookEndpoint(
    input: ApiUpdateWebhookEndpointInput,
  ): Promise<ApiUpdateWebhookEndpointOutput>;
  /** Delete an API webhook endpoint. */
  deleteWebhookEndpoint(
    input: ApiDeleteWebhookEndpointInput,
  ): Promise<ApiDeleteWebhookEndpointOutput>;
  /** Execute an HTTP request through a configured API connection. */
  request(input: ApiRequestInput): Promise<ApiRequestOutput>;
};
declare const api: ApiCodemodeProvider;

type ApiListConnectionsInput = Record<string, unknown>;
type ApiListConnectionsOutput = {
  connections: {
    slug: string;
    name?: string | null;
    baseUrl: string;
    authMode: string;
    status: string;
    createdAt?: string;
    updatedAt?: string;
  }[];
};
type ApiCreateConnectionInput = {
  slug: string;
  name?: string;
  baseUrl: string;
  auth?:
    | {
        type: "none";
      }
    | {
        type: "bearer";
        token: string;
      }
    | {
        type: "basic";
        username: string;
        password: string;
      }
    | {
        type: "oauth";
        authorizationEndpoint: string;
        tokenEndpoint: string;
        clientId: string;
        clientSecret?: string;
        scopes?: string[];
        tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post" | "none";
      }
    | {
        type: "client_credentials";
        tokenEndpoint: string;
        clientId: string;
        clientSecret: string;
        scopes?: string[];
        audience?: string;
        tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post";
      };
};
type ApiCreateConnectionOutput = {
  slug: string;
  name?: string | null;
  baseUrl: string;
  authMode: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
};
type ApiDeleteConnectionInput = {
  slug: string;
};
type ApiDeleteConnectionOutput = {
  ok: true;
};
type ApiGetAuthStatusInput = {
  slug: string;
};
type ApiGetAuthStatusOutput = {
  authenticated: boolean;
  mode: string;
  expiresAt?: string | null;
};
type ApiSetTokenInput = {
  slug: string;
  token: string;
};
type ApiSetTokenOutput = {
  authenticated: boolean;
  mode: string;
  expiresAt?: string | null;
};
type ApiStartOAuthInput = {
  slug: string;
  scopes?: string[];
  extraAuthorizationParams?: {
    [key: string]: string;
  };
};
type ApiStartOAuthOutput = {
  authorizationUrl: string;
  state: string;
};
type ApiDeleteAuthInput = {
  slug: string;
};
type ApiDeleteAuthOutput = {
  ok: true;
};
type ApiListWebhookEndpointsInput = Record<string, unknown>;
type ApiListWebhookEndpointsOutput = {
  endpoints: {
    id: string;
    name: string;
    status: "draft" | "active" | "disabled";
    authConfig:
      | {
          type: "none";
        }
      | {
          type: "bearer";
          tokenRef: string;
        }
      | {
          type: "apiKey";
          location: "header" | "query";
          name: string;
          secretRef: string;
        }
      | {
          type: "basic";
          usernameRef: string;
          passwordRef: string;
        }
      | {
          type: "hmac";
          secretRef: string;
          algorithm: "sha1" | "sha256" | "sha512";
          signature: {
            location: "header" | "query";
            name: string;
            encoding: "hex" | "base64" | "base64url";
            prefix?: string;
          };
          signedPayload:
            | {
                type: "rawBody";
              }
            | {
                type: "timestampedBody";
                prefix: string;
                timestampHeader: string;
                delimiter: string;
                toleranceSeconds: number;
              };
        };
    verification:
      | {
          type: "none";
        }
      | {
          type: "challenge";
          method: "GET" | "POST";
          when:
            | {
                type: "present";
                source:
                  | {
                      type: "header";
                      name: string;
                    }
                  | {
                      type: "query";
                      name: string;
                    }
                  | {
                      type: "jsonBodyPath";
                      path: string[];
                    };
              }
            | {
                type: "equals";
                source:
                  | {
                      type: "header";
                      name: string;
                    }
                  | {
                      type: "query";
                      name: string;
                    }
                  | {
                      type: "jsonBodyPath";
                      path: string[];
                    };
                value: string;
              };
          response: {
            type: "echoText";
            source:
              | {
                  type: "header";
                  name: string;
                }
              | {
                  type: "query";
                  name: string;
                }
              | {
                  type: "jsonBodyPath";
                  path: string[];
                };
          };
        };
    deliveryIdentity:
      | {
          type: "header";
          name: string;
        }
      | {
          type: "query";
          name: string;
        }
      | {
          type: "jsonBodyPath";
          path: string[];
        };
    secretRefs: string[];
    createdAt?: string;
    updatedAt?: string;
    publicUrl: string | null;
  }[];
};
type ApiGetWebhookEndpointInput = {
  endpointId: string;
};
type ApiGetWebhookEndpointOutput = {
  id: string;
  name: string;
  status: "draft" | "active" | "disabled";
  authConfig:
    | {
        type: "none";
      }
    | {
        type: "bearer";
        tokenRef: string;
      }
    | {
        type: "apiKey";
        location: "header" | "query";
        name: string;
        secretRef: string;
      }
    | {
        type: "basic";
        usernameRef: string;
        passwordRef: string;
      }
    | {
        type: "hmac";
        secretRef: string;
        algorithm: "sha1" | "sha256" | "sha512";
        signature: {
          location: "header" | "query";
          name: string;
          encoding: "hex" | "base64" | "base64url";
          prefix?: string;
        };
        signedPayload:
          | {
              type: "rawBody";
            }
          | {
              type: "timestampedBody";
              prefix: string;
              timestampHeader: string;
              delimiter: string;
              toleranceSeconds: number;
            };
      };
  verification:
    | {
        type: "none";
      }
    | {
        type: "challenge";
        method: "GET" | "POST";
        when:
          | {
              type: "present";
              source:
                | {
                    type: "header";
                    name: string;
                  }
                | {
                    type: "query";
                    name: string;
                  }
                | {
                    type: "jsonBodyPath";
                    path: string[];
                  };
            }
          | {
              type: "equals";
              source:
                | {
                    type: "header";
                    name: string;
                  }
                | {
                    type: "query";
                    name: string;
                  }
                | {
                    type: "jsonBodyPath";
                    path: string[];
                  };
              value: string;
            };
        response: {
          type: "echoText";
          source:
            | {
                type: "header";
                name: string;
              }
            | {
                type: "query";
                name: string;
              }
            | {
                type: "jsonBodyPath";
                path: string[];
              };
        };
      };
  deliveryIdentity:
    | {
        type: "header";
        name: string;
      }
    | {
        type: "query";
        name: string;
      }
    | {
        type: "jsonBodyPath";
        path: string[];
      };
  secretRefs: string[];
  createdAt?: string;
  updatedAt?: string;
  publicUrl: string | null;
};
type ApiCreateWebhookEndpointInput = {
  name: string;
  status?: "draft" | "active" | "disabled";
  verification:
    | {
        type: "none";
      }
    | {
        type: "challenge";
        method: "GET" | "POST";
        when:
          | {
              type: "present";
              source:
                | {
                    type: "header";
                    name: string;
                  }
                | {
                    type: "query";
                    name: string;
                  }
                | {
                    type: "jsonBodyPath";
                    path: string[];
                  };
            }
          | {
              type: "equals";
              source:
                | {
                    type: "header";
                    name: string;
                  }
                | {
                    type: "query";
                    name: string;
                  }
                | {
                    type: "jsonBodyPath";
                    path: string[];
                  };
              value: string;
            };
        response: {
          type: "echoText";
          source:
            | {
                type: "header";
                name: string;
              }
            | {
                type: "query";
                name: string;
              }
            | {
                type: "jsonBodyPath";
                path: string[];
              };
        };
      };
  deliveryIdentity:
    | {
        type: "header";
        name: string;
      }
    | {
        type: "query";
        name: string;
      }
    | {
        type: "jsonBodyPath";
        path: string[];
      };
  auth:
    | {
        type: "none";
      }
    | {
        type: "bearer";
        token: string;
      }
    | {
        type: "apiKey";
        location: "header" | "query";
        name: string;
        secret: string;
      }
    | {
        type: "basic";
        username: string;
        password: string;
      }
    | {
        type: "hmac";
        secret: string;
        algorithm: "sha1" | "sha256" | "sha512";
        signature: {
          location: "header" | "query";
          name: string;
          encoding: "hex" | "base64" | "base64url";
          prefix?: string;
        };
        signedPayload:
          | {
              type: "rawBody";
            }
          | {
              type: "timestampedBody";
              prefix: string;
              timestampHeader: string;
              delimiter: string;
              toleranceSeconds: number;
            };
      };
  endpointId: string;
};
type ApiCreateWebhookEndpointOutput = {
  id: string;
  name: string;
  status: "draft" | "active" | "disabled";
  authConfig:
    | {
        type: "none";
      }
    | {
        type: "bearer";
        tokenRef: string;
      }
    | {
        type: "apiKey";
        location: "header" | "query";
        name: string;
        secretRef: string;
      }
    | {
        type: "basic";
        usernameRef: string;
        passwordRef: string;
      }
    | {
        type: "hmac";
        secretRef: string;
        algorithm: "sha1" | "sha256" | "sha512";
        signature: {
          location: "header" | "query";
          name: string;
          encoding: "hex" | "base64" | "base64url";
          prefix?: string;
        };
        signedPayload:
          | {
              type: "rawBody";
            }
          | {
              type: "timestampedBody";
              prefix: string;
              timestampHeader: string;
              delimiter: string;
              toleranceSeconds: number;
            };
      };
  verification:
    | {
        type: "none";
      }
    | {
        type: "challenge";
        method: "GET" | "POST";
        when:
          | {
              type: "present";
              source:
                | {
                    type: "header";
                    name: string;
                  }
                | {
                    type: "query";
                    name: string;
                  }
                | {
                    type: "jsonBodyPath";
                    path: string[];
                  };
            }
          | {
              type: "equals";
              source:
                | {
                    type: "header";
                    name: string;
                  }
                | {
                    type: "query";
                    name: string;
                  }
                | {
                    type: "jsonBodyPath";
                    path: string[];
                  };
              value: string;
            };
        response: {
          type: "echoText";
          source:
            | {
                type: "header";
                name: string;
              }
            | {
                type: "query";
                name: string;
              }
            | {
                type: "jsonBodyPath";
                path: string[];
              };
        };
      };
  deliveryIdentity:
    | {
        type: "header";
        name: string;
      }
    | {
        type: "query";
        name: string;
      }
    | {
        type: "jsonBodyPath";
        path: string[];
      };
  secretRefs: string[];
  createdAt?: string;
  updatedAt?: string;
  publicUrl: string | null;
};
type ApiUpdateWebhookEndpointInput = {
  name?: string;
  status?: "draft" | "active" | "disabled";
  verification?:
    | {
        type: "none";
      }
    | {
        type: "challenge";
        method: "GET" | "POST";
        when:
          | {
              type: "present";
              source:
                | {
                    type: "header";
                    name: string;
                  }
                | {
                    type: "query";
                    name: string;
                  }
                | {
                    type: "jsonBodyPath";
                    path: string[];
                  };
            }
          | {
              type: "equals";
              source:
                | {
                    type: "header";
                    name: string;
                  }
                | {
                    type: "query";
                    name: string;
                  }
                | {
                    type: "jsonBodyPath";
                    path: string[];
                  };
              value: string;
            };
        response: {
          type: "echoText";
          source:
            | {
                type: "header";
                name: string;
              }
            | {
                type: "query";
                name: string;
              }
            | {
                type: "jsonBodyPath";
                path: string[];
              };
        };
      };
  deliveryIdentity?:
    | {
        type: "header";
        name: string;
      }
    | {
        type: "query";
        name: string;
      }
    | {
        type: "jsonBodyPath";
        path: string[];
      };
  auth?:
    | {
        type: "none";
      }
    | {
        type: "bearer";
        token: string;
      }
    | {
        type: "apiKey";
        location: "header" | "query";
        name: string;
        secret: string;
      }
    | {
        type: "basic";
        username: string;
        password: string;
      }
    | {
        type: "hmac";
        secret: string;
        algorithm: "sha1" | "sha256" | "sha512";
        signature: {
          location: "header" | "query";
          name: string;
          encoding: "hex" | "base64" | "base64url";
          prefix?: string;
        };
        signedPayload:
          | {
              type: "rawBody";
            }
          | {
              type: "timestampedBody";
              prefix: string;
              timestampHeader: string;
              delimiter: string;
              toleranceSeconds: number;
            };
      };
  endpointId: string;
};
type ApiUpdateWebhookEndpointOutput = {
  id: string;
  name: string;
  status: "draft" | "active" | "disabled";
  authConfig:
    | {
        type: "none";
      }
    | {
        type: "bearer";
        tokenRef: string;
      }
    | {
        type: "apiKey";
        location: "header" | "query";
        name: string;
        secretRef: string;
      }
    | {
        type: "basic";
        usernameRef: string;
        passwordRef: string;
      }
    | {
        type: "hmac";
        secretRef: string;
        algorithm: "sha1" | "sha256" | "sha512";
        signature: {
          location: "header" | "query";
          name: string;
          encoding: "hex" | "base64" | "base64url";
          prefix?: string;
        };
        signedPayload:
          | {
              type: "rawBody";
            }
          | {
              type: "timestampedBody";
              prefix: string;
              timestampHeader: string;
              delimiter: string;
              toleranceSeconds: number;
            };
      };
  verification:
    | {
        type: "none";
      }
    | {
        type: "challenge";
        method: "GET" | "POST";
        when:
          | {
              type: "present";
              source:
                | {
                    type: "header";
                    name: string;
                  }
                | {
                    type: "query";
                    name: string;
                  }
                | {
                    type: "jsonBodyPath";
                    path: string[];
                  };
            }
          | {
              type: "equals";
              source:
                | {
                    type: "header";
                    name: string;
                  }
                | {
                    type: "query";
                    name: string;
                  }
                | {
                    type: "jsonBodyPath";
                    path: string[];
                  };
              value: string;
            };
        response: {
          type: "echoText";
          source:
            | {
                type: "header";
                name: string;
              }
            | {
                type: "query";
                name: string;
              }
            | {
                type: "jsonBodyPath";
                path: string[];
              };
        };
      };
  deliveryIdentity:
    | {
        type: "header";
        name: string;
      }
    | {
        type: "query";
        name: string;
      }
    | {
        type: "jsonBodyPath";
        path: string[];
      };
  secretRefs: string[];
  createdAt?: string;
  updatedAt?: string;
  publicUrl: string | null;
};
type ApiDeleteWebhookEndpointInput = {
  endpointId: string;
};
type ApiDeleteWebhookEndpointOutput = {
  ok: true;
};
type ApiRequestInput = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: {
    [key: string]: string;
  };
  headers?: {
    [key: string]: string;
  };
  body:
    | {
        type: "empty";
      }
    | {
        type: "json";
        value: unknown;
      }
    | {
        type: "text";
        value: string;
      };
  timeoutMs?: number;
  slug: string;
};
type ApiRequestOutput =
  | {
      ok: true;
      response: {
        status: number;
        statusText: string;
        headers: {
          [key: string]: string;
        };
        body:
          | {
              type: "json";
              value: unknown;
            }
          | {
              type: "text";
              value: string;
            }
          | {
              type: "empty";
              value: null;
            };
      };
      error: null;
    }
  | {
      ok: false;
      response: {
        status: number;
        statusText: string;
        headers: {
          [key: string]: string;
        };
        body:
          | {
              type: "json";
              value: unknown;
            }
          | {
              type: "text";
              value: string;
            }
          | {
              type: "empty";
              value: null;
            };
      } | null;
      error: {
        code:
          | "HTTP_ERROR"
          | "REQUEST_ERROR"
          | "RESPONSE_DECODING_ERROR"
          | "CONNECTION_NOT_FOUND"
          | "CONNECTION_DISABLED";
        message: string;
      };
    };
