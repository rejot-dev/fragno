import { describe, expect, test } from "vitest";
import dedent from "dedent";
import { transform } from "./transform";

describe("defineFragment withDependencies and withServices transformation", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    import { OpenAI } from "openai";
    
    const chatnoDefinition = defineFragment("chatno")
      .withDependencies((config) => {
        return {
          openaiClient: new OpenAI({
            apiKey: config.openaiApiKey || process.env["OPENAI_API_KEY"],
          }),
        };
      })
      .withServices((config, deps) => {
        return {
          messageStore: new MessageStore(),
        };
      });
  `;

  test("ssr:true - keeps original methods", () => {
    const result = transform(source, "", { ssr: true });
    expect(result.code).toContain("new OpenAI");
    expect(result.code).toContain("new MessageStore");
    expect(result.code).toContain("openaiClient");
    expect(result.code).toContain("messageStore");
  });

  test("ssr:false - replaces methods with no-ops", () => {
    const expected = dedent`
    import { defineFragment } from "@fragno-dev/core";
    const chatnoDefinition = defineFragment("chatno").withDependencies(() => {}).withServices(() => {});
    `;
    const result = transform(source, "", { ssr: false });
    expect(result.code).toBe(expected);
  });
});

describe("defineFragment with type parameters", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    
    interface ServerConfig {
      apiKey: string;
    }
    
    const lib = defineFragment<ServerConfig>("mylib")
      .withDependencies((config: ServerConfig) => {
        return {
          client: createClient(config.apiKey)
        };
      })
      .withServices((config: ServerConfig, deps: any) => {
        return {
          service: new Service(deps.client)
        };
      });
  `;

  test("ssr:false - handles typed parameters", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("createClient");
    expect(result.code).not.toContain("new Service");
    expect(result.code).toContain("() => {}");
  });
});

describe("defineFragment with only withDependencies", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    
    const lib = defineFragment("mylib")
      .withDependencies((config) => {
        return {
          db: connectDB(config.dbUrl)
        };
      });
  `;

  test("ssr:false - transforms single method", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("connectDB");
    expect(result.code).toContain("() => {}");
  });
});

describe("defineFragment with only withServices", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    
    const lib = defineFragment("mylib")
      .withServices((config, deps) => {
        return {
          userService: new UserService()
        };
      });
  `;

  test("ssr:false - transforms single method", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("UserService");
    expect(result.code).toContain("() => {}");
  });
});

describe("defineFragment with aliased import", () => {
  const source = dedent`
    import { defineFragment as createLib } from "@fragno-dev/core";
    
    const lib = createLib("mylib")
      .withDependencies(() => ({ db: database }))
      .withServices(() => ({ api: apiService }));
  `;

  test("ssr:false - handles aliased imports", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("database");
    expect(result.code).not.toContain("apiService");
    expect(result.code).toContain("() => {}");
  });
});

describe("non-fragno defineFragment - should not transform", () => {
  const source = dedent`
    import { defineFragment } from "other-package";
    
    const lib = defineFragment("mylib")
      .withDependencies(() => ({ db: database }))
      .withServices(() => ({ api: apiService }));
  `;

  test("ssr:false - does not transform non-fragno defineFragment", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("database");
    expect(result.code).toContain("apiService");
  });
});

describe("defineFragment with multiple method calls", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    
    const lib = defineFragment("mylib")
      .withDependencies(() => ({ dep1: service1 }))
      .withOtherMethod(() => ({ other: otherService }))
      .withServices(() => ({ dep2: service2 }));
  `;

  test("ssr:false - only transforms withDependencies and withServices", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("service1");
    expect(result.code).not.toContain("service2");
    expect(result.code).toContain("otherService");
    expect(result.code).toContain("withOtherMethod");
  });
});

describe("defineFragment with inline function expressions", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    
    const lib = defineFragment("mylib")
      .withDependencies(function(config) {
        return {
          client: new Client(config)
        };
      })
      .withServices(function(config, deps) {
        return {
          service: new Service(deps)
        };
      });
  `;

  test("ssr:false - handles function expressions", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("new Client");
    expect(result.code).not.toContain("new Service");
    expect(result.code).toContain("() => {}");
  });
});

describe("defineFragment with async functions", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    
    const lib = defineFragment("mylib")
      .withDependencies(async (config) => {
        const client = await createAsyncClient(config);
        return { client };
      })
      .withServices(async (config, deps) => {
        const service = await createAsyncService(deps);
        return { service };
      });
  `;

  test("ssr:false - handles async functions", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("createAsyncClient");
    expect(result.code).not.toContain("createAsyncService");
    expect(result.code).toContain("() => {}");
  });
});

describe("multiple defineFragment calls in same file", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    
    const lib1 = defineFragment("lib1")
      .withDependencies(() => ({ dep1: service1 }))
      .withServices(() => ({ svc1: serviceA }));
    
    const lib2 = defineFragment("lib2")
      .withDependencies(() => ({ dep2: service2 }))
      .withServices(() => ({ svc2: serviceB }));
  `;

  test("ssr:false - transforms all defineFragment calls", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("service1");
    expect(result.code).not.toContain("service2");
    expect(result.code).not.toContain("serviceA");
    expect(result.code).not.toContain("serviceB");
    // Should have multiple no-op functions
    const returnThisCount = (result.code.match(/() => {}/g) || []).length;
    expect(returnThisCount).toBeGreaterThan(2);
  });
});

describe("defineFragment with complex dependency objects", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    import { OpenAI } from "openai";
    import { Database } from "./database";
    
    const lib = defineFragment("complex")
      .withDependencies((config) => {
        const openai = new OpenAI({ apiKey: config.apiKey });
        const db = new Database(config.dbUrl);
        
        return {
          ai: openai,
          database: db,
          cache: createCache(),
          logger: console.log
        };
      })
      .withServices((config, deps) => {
        class CustomService {
          constructor() {
            this.ai = deps.ai;
          }
        }
        
        return {
          custom: new CustomService(),
          utils: {
            helper: () => deps.database.query()
          }
        };
      });
  `;

  test("ssr:false - removes all dependency code", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("OpenAI");
    expect(result.code).not.toContain("Database");
    expect(result.code).not.toContain("createCache");
    expect(result.code).not.toContain("CustomService");
    expect(result.code).not.toContain("console.log");
    expect(result.code).toContain("() => {}");
  });
});

describe("defineFragment with spread operators and destructuring", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    
    const baseDeps = { base: baseService };
    
    const lib = defineFragment("spread")
      .withDependencies(({ apiKey, ...rest }) => {
        return {
          ...baseDeps,
          extra: createExtra(apiKey),
          ...rest
        };
      })
      .withServices((config, { base, ...deps }) => {
        return {
          service: new Service(base),
          ...deps
        };
      });
  `;

  test("ssr:false - handles spread and destructuring", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("baseDeps");
    expect(result.code).not.toContain("baseService");
    expect(result.code).not.toContain("createExtra");
    expect(result.code).not.toContain("new Service");
    expect(result.code).toContain("() => {}");
  });
});

describe("defineFragment stored in variable then chained", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    
    const baseLib = defineFragment("mylib");
    
    const fullLib = baseLib
      .withDependencies(() => ({ dep: dependency }))
      .withServices(() => ({ svc: service }));
  `;

  test("ssr:false - handles separated chaining", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("dependency");
    expect(result.code).not.toContain("service");
    expect(result.code).toContain("() => {}");
  });
});

describe("defineFragment with comments", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    
    const lib = defineFragment("commented")
      // Setup dependencies
      .withDependencies((config) => {
        // Create OpenAI client
        return {
          openai: new OpenAI({ apiKey: config.apiKey })
        };
      })
      /* Setup services */
      .withServices((config, deps) => {
        return {
          // Message service
          messages: new MessageService(deps.openai)
        };
      });
  `;

  test("ssr:false - preserves structure with comments", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("OpenAI");
    expect(result.code).not.toContain("MessageService");
    expect(result.code).toContain("() => {}");
  });
});
