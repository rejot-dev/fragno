import { describe, expect, test } from "vitest";
import dedent from "dedent";
import { transform } from "./transform";

describe("defineFragment withDependencies and withServices transformation", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    import { OpenAI } from "openai";
    
    const chatnoDefinition = defineFragment("chatno")
      .withDependencies(({ config }) => {
        return {
          openaiClient: new OpenAI({
            apiKey: config.openaiApiKey || process.env["OPENAI_API_KEY"],
          }),
        };
      })
      .withServices(({ config, deps }) => {
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
      .withDependencies(({ config }: { config: ServerConfig }) => {
        return {
          client: createClient(config.apiKey)
        };
      })
      .withServices(({ config, deps }: { config: ServerConfig; deps: any }) => {
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
      .withDependencies(({ config }) => {
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
      .withServices(({ config, deps }) => {
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
      .withDependencies(({ config }) => ({ dep1: service1 }))
      .withOtherMethod(() => ({ other: otherService }))
      .withServices(({ config, deps }) => ({ dep2: service2 }));
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
      .withDependencies(function({ config }) {
        return {
          client: new Client(config)
        };
      })
      .withServices(function({ config, deps }) {
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
      .withDependencies(async ({ config }) => {
        const client = await createAsyncClient(config);
        return { client };
      })
      .withServices(async ({ config, deps }) => {
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
      .withDependencies(({ config }) => ({ dep1: service1 }))
      .withServices(({ config, deps }) => ({ svc1: serviceA }));
    
    const lib2 = defineFragment("lib2")
      .withDependencies(({ config }) => ({ dep2: service2 }))
      .withServices(({ config, deps }) => ({ svc2: serviceB }));
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
      .withDependencies(({ config }) => {
        const openai = new OpenAI({ apiKey: config.apiKey });
        const db = new Database(config.dbUrl);
        
        return {
          ai: openai,
          database: db,
          cache: createCache(),
          logger: console.log
        };
      })
      .withServices(({ config, deps }) => {
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
      .withDependencies(({ config: { apiKey, ...rest } }) => {
        return {
          ...baseDeps,
          extra: createExtra(apiKey),
          ...rest
        };
      })
      .withServices(({ config, deps: { base, ...restDeps } }) => {
        return {
          service: new Service(base),
          ...restDeps
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
      .withDependencies(({ config }) => ({ dep: dependency }))
      .withServices(({ config, deps }) => ({ svc: service }));
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
      .withDependencies(({ config }) => {
        // Create OpenAI client
        return {
          openai: new OpenAI({ apiKey: config.apiKey })
        };
      })
      /* Setup services */
      .withServices(({ config, deps }) => {
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

describe("defineFragmentWithDatabase with full database integration", () => {
  const source = dedent`
    import { column, idColumn, schema } from "@fragno-dev/db/schema";
    import type { TableToInsertValues } from "@fragno-dev/db/query";

    import { defineFragmentWithDatabase } from "@fragno-dev/db";
    import { z } from "zod";

    export const noteSchema = schema((s) => {
      return s.addTable("note", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("content", column("string"))
          .addColumn("userId", column("string"))
          .addColumn("createdAt", column("timestamp").defaultTo$("now"))
          .createIndex("idx_note_user", ["userId"]);
      });
    });
    
    const lib = defineFragmentWithDatabase("mylib")
      .withDatabase(noteSchema)
      .withServices(({ orm }) => {
        return {
          createNote: async (note: TableToInsertValues<typeof noteSchema.tables.note>) => {
            const id = await orm.create("note", note);
            return {
              ...note,
              id: id.toJSON(),
              createdAt: note.createdAt ?? new Date(),
            };
          },
          getNotes: () => {
            return orm.find("note", (b) => b);
          },
          getNotesByUser: (userId: string) => {
            return orm.find("note", (b) =>
              b.whereIndex("idx_note_user", (eb) => eb("userId", "=", userId)),
            );
          },
        };
      });
  `;

  test("ssr:true - keeps original methods", () => {
    const result = transform(source, "", { ssr: true });
    expect(result.code).toContain("noteSchema");
    expect(result.code).toContain("createNote");
    expect(result.code).toContain("orm.create");
    expect(result.code).toContain("orm.find");
  });

  test("ssr:false - transforms database integration", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("orm.create");
    expect(result.code).not.toContain("orm.find");
    expect(result.code).not.toContain("createNote:");
    expect(result.code).toContain("() => {}");

    expect(result.code).toMatchInlineSnapshot(`
      "import { schema } from "@fragno-dev/db/schema";
      import type { TableToInsertValues } from "@fragno-dev/db/query";
      import { defineFragmentWithDatabase } from "@fragno-dev/db";
      import { z } from "zod";
      export const noteSchema = schema(() => {});
      const lib = defineFragmentWithDatabase("mylib").withDatabase(() => {}).withServices(() => {});"
    `);
  });
});

describe("defineFragmentWithDatabase with only withDatabase", () => {
  const source = dedent`
    import { defineFragmentWithDatabase } from "@fragno-dev/db";
    import { mySchema } from "./schema";
    
    const lib = defineFragmentWithDatabase("mylib")
      .withDatabase(mySchema);
  `;

  test("ssr:false - transforms withDatabase", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("mySchema");
    expect(result.code).toContain("() => {}");

    expect(result.code).toMatchInlineSnapshot(`
      "import { defineFragmentWithDatabase } from "@fragno-dev/db";
      const lib = defineFragmentWithDatabase("mylib").withDatabase(() => {});"
    `);
  });
});

describe("defineFragmentWithDatabase with withDatabase and withDependencies", () => {
  const source = dedent`
    import { defineFragmentWithDatabase } from "@fragno-dev/db";
    import { schema } from "@fragno-dev/db/schema";
    
    const mySchema = schema((s) => s.addTable("users", (t) => t));
    
    const lib = defineFragmentWithDatabase("mylib")
      .withDatabase(mySchema)
      .withDependencies(({ config, orm }) => {
        return {
          externalApi: createApiClient(config.apiKey)
        };
      });
  `;

  test("ssr:false - transforms both methods", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("createApiClient");
    expect(result.code).not.toContain("externalApi");
    // Should have two no-op functions
    const noOpCount = (result.code.match(/\(\) => \{\}/g) || []).length;
    expect(noOpCount).toBe(2);

    expect(result.code).toMatchInlineSnapshot(`
      "import { defineFragmentWithDatabase } from "@fragno-dev/db";
      const lib = defineFragmentWithDatabase("mylib").withDatabase(() => {}).withDependencies(() => {});"
    `);
  });
});

describe("defineFragmentWithDatabase with all three methods", () => {
  const source = dedent`
    import { defineFragmentWithDatabase } from "@fragno-dev/db";
    import { mySchema } from "./schema";
    
    const lib = defineFragmentWithDatabase("mylib")
      .withDatabase(mySchema)
      .withDependencies(({ config, orm }) => ({
        api: createApi(config.apiUrl)
      }))
      .withServices(({ config, deps, orm }) => ({
        userService: new UserService(orm, deps.api)
      }));
  `;

  test("ssr:false - transforms all three methods", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("mySchema");
    expect(result.code).not.toContain("createApi");
    expect(result.code).not.toContain("UserService");
    // Should have three no-op functions
    const noOpCount = (result.code.match(/\(\) => \{\}/g) || []).length;
    expect(noOpCount).toBe(3);
  });
});

describe("defineFragmentWithDatabase with aliased import", () => {
  const source = dedent`
    import { defineFragmentWithDatabase as defineDbFragment } from "@fragno-dev/db";
    import { mySchema } from "./schema";
    
    const lib = defineDbFragment("mylib")
      .withDatabase(mySchema)
      .withServices(({ orm }) => ({
        getUsers: () => orm.find("users", (b) => b)
      }));
  `;

  test("ssr:false - handles aliased imports", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("mySchema");
    expect(result.code).not.toContain("orm.find");
    expect(result.code).toContain("() => {}");
  });
});

describe("multiple defineFragmentWithDatabase calls in same file", () => {
  const source = dedent`
    import { defineFragmentWithDatabase } from "@fragno-dev/db";
    import { schema1, schema2 } from "./schemas";
    
    const lib1 = defineFragmentWithDatabase("lib1")
      .withDatabase(schema1)
      .withServices(({ config, deps, orm }) => ({
        service1: new Service1(orm)
      }));
    
    const lib2 = defineFragmentWithDatabase("lib2")
      .withDatabase(schema2)
      .withServices(({ config, deps, orm }) => ({
        service2: new Service2(orm)
      }));
  `;

  test("ssr:false - transforms all calls", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("schema1");
    expect(result.code).not.toContain("schema2");
    expect(result.code).not.toContain("Service1");
    expect(result.code).not.toContain("Service2");
    // Should have four no-op functions (2 withDatabase + 2 withServices)
    const noOpCount = (result.code.match(/\(\) => \{\}/g) || []).length;
    expect(noOpCount).toBeGreaterThanOrEqual(4);
  });
});

describe("mixed defineFragment and defineFragmentWithDatabase", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    import { defineFragmentWithDatabase } from "@fragno-dev/db";
    import { mySchema } from "./schema";
    
    const regularLib = defineFragment("regular")
      .withDependencies(({ config }) => ({ dep: dependency1 }))
      .withServices(({ config, deps }) => ({ svc: service1 }));
    
    const dbLib = defineFragmentWithDatabase("db")
      .withDatabase(mySchema)
      .withDependencies(({ config, orm }) => ({ dep: dependency2 }))
      .withServices(({ config, deps, orm }) => ({ svc: service2 }));
  `;

  test("ssr:false - transforms both types", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("dependency1");
    expect(result.code).not.toContain("dependency2");
    expect(result.code).not.toContain("service1");
    expect(result.code).not.toContain("service2");
    expect(result.code).not.toContain("mySchema");
    // Should have five no-op functions (2 for regular + 3 for db)
    const noOpCount = (result.code.match(/\(\) => \{\}/g) || []).length;
    expect(noOpCount).toBeGreaterThanOrEqual(5);
  });
});

describe("defineFragmentWithDatabase stored in variable then chained", () => {
  const source = dedent`
    import { defineFragmentWithDatabase } from "@fragno-dev/db";
    import { mySchema } from "./schema";
    
    const baseLib = defineFragmentWithDatabase("mylib");
    
    const withDb = baseLib.withDatabase(mySchema);
    
    const fullLib = withDb
      .withDependencies(({ config, orm }) => ({ dep: dependency }))
      .withServices(({ config, deps, orm }) => ({ svc: service }));
  `;

  test("ssr:false - handles separated chaining", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("mySchema");
    expect(result.code).not.toContain("dependency");
    expect(result.code).not.toContain("service");
    expect(result.code).toContain("() => {}");
  });
});

describe("schema utility function transformation", () => {
  const source = dedent`
    import { column, idColumn, schema } from "@fragno-dev/db/schema";
    import { defineFragmentWithDatabase } from "@fragno-dev/db";

    export const noteSchema = schema((s) => {
      return s.addTable("note", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("content", column("string"))
          .addColumn("userId", column("string"))
          .addColumn("createdAt", column("timestamp").defaultTo$("now"))
          .createIndex("idx_note_user", ["userId"]);
      });
    });
    
    const lib = defineFragmentWithDatabase("mylib")
      .withDatabase(noteSchema);
  `;

  test("ssr:false - transforms schema call to no-op", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("schema(() => {})");
    expect(result.code).not.toContain("addTable");
    expect(result.code).not.toContain("addColumn");
    expect(result.code).not.toContain("createIndex");
  });

  test("ssr:true - keeps schema implementation", () => {
    const result = transform(source, "", { ssr: true });
    expect(result.code).toContain("addTable");
    expect(result.code).toContain("addColumn");
    expect(result.code).toContain("createIndex");
  });
});

describe("schema from @fragno-dev/db", () => {
  const source = dedent`
    import { schema } from "@fragno-dev/db";
    import { defineFragmentWithDatabase } from "@fragno-dev/db";

    export const mySchema = schema((s) => {
      return s.addTable("users", (t) => t);
    });
    
    const lib = defineFragmentWithDatabase("mylib")
      .withDatabase(mySchema);
  `;

  test("ssr:false - transforms schema from main package", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("schema(() => {})");
    expect(result.code).not.toContain("addTable");
  });
});

describe("multiple schema calls", () => {
  const source = dedent`
    import { schema } from "@fragno-dev/db/schema";
    import { defineFragmentWithDatabase } from "@fragno-dev/db";

    export const schema1 = schema((s) => {
      return s.addTable("users", (t) => t);
    });
    
    export const schema2 = schema((s) => {
      return s.addTable("posts", (t) => t);
    });
    
    const lib1 = defineFragmentWithDatabase("lib1").withDatabase(schema1);
    const lib2 = defineFragmentWithDatabase("lib2").withDatabase(schema2);
  `;

  test("ssr:false - transforms all schema calls", () => {
    const result = transform(source, "", { ssr: false });
    const schemaNoOpCount = (result.code.match(/schema\(\(\) => \{\}\)/g) || []).length;
    expect(schemaNoOpCount).toBe(2);
    expect(result.code).not.toContain("addTable");
  });
});
