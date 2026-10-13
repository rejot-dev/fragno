// api tools
type ApiCodemodeProvider = {
  /** List API webhook endpoints configured for the current scope. */
  listWebhookEndpoints(): Promise<ApiListWebhookEndpointsOutput>;
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
};
declare const api: ApiCodemodeProvider;

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
