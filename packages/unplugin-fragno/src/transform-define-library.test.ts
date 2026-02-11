import { describe, expect, test } from "vitest";
import dedent from "dedent";
import { transform } from "./transform";

describe("defineFragment withDependencies and providesService transformation", () => {
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
      .providesService(({ config, deps }) => {
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

  test("ssr:false - replaces withDependencies but keeps providesService", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain(".withDependencies(() => {})");
    expect(result.code).not.toContain("new OpenAI");
    expect(result.code).toContain("new MessageStore");
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
      .providesService(({ config, deps }: { config: ServerConfig; deps: any }) => {
        return {
          service: new Service(deps.client)
        };
      });
  `;

  test("ssr:false - handles typed parameters", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("createClient");
    expect(result.code).toContain("new Service");
    expect(result.code).toContain(".withDependencies(() => {})");
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

describe("defineFragment with only providesService", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    
    const lib = defineFragment("mylib")
      .providesService(({ config, deps }) => {
        return {
          userService: new UserService()
        };
      });
  `;

  test("ssr:false - transforms single method", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("new UserService");
  });
});

describe("defineFragment with usesService", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    
    const lib = defineFragment("mylib")
      .usesService("email", { optional: true })
      .providesService(({ deps }) => {
        return {
          sendWelcome: () => {
            if (deps.email) {
              deps.email.send("Welcome!");
            }
          }
        };
      });
  `;

  test("ssr:false - preserves providesService callback and usesService call", () => {
    const result = transform(source, "", { ssr: false });
    // providesService callback should be preserved
    expect(result.code).toContain("deps.email.send");
    // usesService call should be preserved (it doesn't have a callback)
    expect(result.code).toContain('usesService("email"');
    expect(result.code).toContain("optional: true");
  });

  test("ssr:true - keeps all original code", () => {
    const result = transform(source, "", { ssr: true });
    expect(result.code).toContain("deps.email");
    expect(result.code).toContain("send");
    expect(result.code).toContain("usesService");
  });
});

describe("defineFragment with aliased import", () => {
  const source = dedent`
    import { defineFragment as createLib } from "@fragno-dev/core";
    
    const lib = createLib("mylib")
      .withDependencies(() => ({ db: database }))
      .providesService(() => ({ api: apiService }));
  `;

  test("ssr:false - handles aliased imports", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("database");
    expect(result.code).toContain("apiService");
    expect(result.code).toContain(".withDependencies(() => {})");
  });
});

describe("non-fragno defineFragment - should not transform", () => {
  const source = dedent`
    import { defineFragment } from "other-package";
    
    const lib = defineFragment("mylib")
      .withDependencies(() => ({ db: database }))
      .providesService(() => ({ api: apiService }));
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
      .providesService(({ config, deps }) => ({ dep2: service2 }));
  `;

  test("ssr:false - only transforms withDependencies and providesService", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("service1");
    expect(result.code).toContain("service2");
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
      .providesService(function({ config, deps }) {
        return {
          service: new Service(deps)
        };
      });
  `;

  test("ssr:false - handles function expressions", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("new Client");
    expect(result.code).toContain("new Service");
    expect(result.code).toContain(".withDependencies(() => {})");
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
      .providesService(async ({ config, deps }) => {
        const service = await createAsyncService(deps);
        return { service };
      });
  `;

  test("ssr:false - handles async functions", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("createAsyncClient");
    expect(result.code).toContain("createAsyncService");
    expect(result.code).toContain(".withDependencies(() => {})");
  });
});

describe("multiple defineFragment calls in same file", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    
    const lib1 = defineFragment("lib1")
      .withDependencies(({ config }) => ({ dep1: service1 }))
      .providesService(({ config, deps }) => ({ svc1: serviceA }));
    
    const lib2 = defineFragment("lib2")
      .withDependencies(({ config }) => ({ dep2: service2 }))
      .providesService(({ config, deps }) => ({ svc2: serviceB }));
  `;

  test("ssr:false - transforms all defineFragment calls", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("service1");
    expect(result.code).not.toContain("service2");
    expect(result.code).toContain("serviceA");
    expect(result.code).toContain("serviceB");
    // Should have multiple no-op functions for withDependencies
    const returnThisCount = (result.code.match(/withDependencies\(\(\) => \{\}\)/g) || []).length;
    expect(returnThisCount).toBe(2);
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
      .providesService(({ config, deps }) => {
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
    expect(result.code).toContain("CustomService");
    expect(result.code).not.toContain("console.log");
    expect(result.code).toContain(".withDependencies(() => {})");
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
      .providesService(({ config, deps: { base, ...restDeps } }) => {
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
    expect(result.code).toContain("new Service");
    expect(result.code).toContain(".withDependencies(() => {})");
  });
});

describe("defineFragment stored in variable then chained", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    
    const baseLib = defineFragment("mylib");
    
    const fullLib = baseLib
      .withDependencies(({ config }) => ({ dep: dependency }))
      .providesService(({ config, deps }) => ({ svc: service }));
  `;

  test("ssr:false - handles separated chaining", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("dependency");
    expect(result.code).toContain("service");
    expect(result.code).toContain(".withDependencies(() => {})");
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
      .providesService(({ config, deps }) => {
        return {
          // Message service
          messages: new MessageService(deps.openai)
        };
      });
  `;

  test("ssr:false - preserves structure with comments", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("OpenAI");
    expect(result.code).toContain("MessageService");
    expect(result.code).toContain(".withDependencies(() => {})");
  });
});

describe("defineFragmentWithDatabase with full database integration", () => {
  const source = dedent`
    import { column, idColumn, schema } from "@fragno-dev/db/schema";
    import type { TableToInsertValues } from "@fragno-dev/db/query";

    import { defineFragmentWithDatabase } from "@fragno-dev/db";
    import { z } from "zod";

    export const noteSchema = schema("note", (s) => {
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
      .providesService(({ orm }) => {
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
    expect(result.code).toContain("orm.create");
    expect(result.code).toContain("orm.find");
    expect(result.code).toContain("createNote:");
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
    expect(result.code).not.toContain("withDatabase");

    expect(result.code).toMatchInlineSnapshot(`
      "import { defineFragment } from "@fragno-dev/core";
      const lib = defineFragment("mylib");"
    `);
  });
});

describe("defineFragmentWithDatabase with withDatabase and withDependencies", () => {
  const source = dedent`
    import { defineFragmentWithDatabase } from "@fragno-dev/db";
    import { schema } from "@fragno-dev/db/schema";
    
    const mySchema = schema("my", (s) => s.addTable("users", (t) => t));
    
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
    expect(result.code).not.toContain("withDatabase");
    // Should have one no-op function (withDependencies)
    const noOpCount = (result.code.match(/\(\) => \{\}/g) || []).length;
    expect(noOpCount).toBe(1);

    expect(result.code).toMatchInlineSnapshot(`
      "import { defineFragment } from "@fragno-dev/core";
      const lib = defineFragment("mylib").withDependencies(() => {});"
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
      .providesService(({ config, deps, orm }) => ({
        userService: new UserService(orm, deps.api)
      }));
  `;

  test("ssr:false - transforms all three methods", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("mySchema");
    expect(result.code).not.toContain("createApi");
    expect(result.code).toContain("UserService");
    expect(result.code).not.toContain("withDatabase");
    // Should have one no-op function (withDependencies)
    const noOpCount = (result.code.match(/withDependencies\(\(\) => \{\}\)/g) || []).length;
    expect(noOpCount).toBe(1);
  });
});

describe("defineFragmentWithDatabase with aliased import", () => {
  const source = dedent`
    import { defineFragmentWithDatabase as defineDbFragment } from "@fragno-dev/db";
    import { mySchema } from "./schema";
    
    const lib = defineDbFragment("mylib")
      .withDatabase(mySchema)
      .providesService(({ orm }) => ({
        getUsers: () => orm.find("users", (b) => b)
      }));
  `;

  test("ssr:false - handles aliased imports", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("mySchema");
    expect(result.code).toContain("orm.find");
    expect(result.code).not.toContain("withDatabase");
    expect(result.code).toContain("providesService((");
    expect(result.code).toContain("orm");
    expect(result.code).toContain("getUsers");
    expect(result.code).toContain('defineFragment("mylib")');
  });
});

describe("multiple defineFragmentWithDatabase calls in same file", () => {
  const source = dedent`
    import { defineFragmentWithDatabase } from "@fragno-dev/db";
    import { schema1, schema2 } from "./schemas";
    
    const lib1 = defineFragmentWithDatabase("lib1")
      .withDatabase(schema1)
      .providesService(({ config, deps, orm }) => ({
        service1: new Service1(orm)
      }));
    
    const lib2 = defineFragmentWithDatabase("lib2")
      .withDatabase(schema2)
      .providesService(({ config, deps, orm }) => ({
        service2: new Service2(orm)
      }));
  `;

  test("ssr:false - transforms all calls", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("schema1");
    expect(result.code).not.toContain("schema2");
    expect(result.code).toContain("Service1");
    expect(result.code).toContain("Service2");
    expect(result.code).not.toContain("withDatabase");
    // Should have no-op functions only for withDependencies (none here)
    const noOpCount = (result.code.match(/withDependencies\(\(\) => \{\}\)/g) || []).length;
    expect(noOpCount).toBe(0);
    expect(result.code).toContain('defineFragment("lib1")');
    expect(result.code).toContain('defineFragment("lib2")');
  });
});

describe("mixed defineFragment and defineFragmentWithDatabase", () => {
  const source = dedent`
    import { defineFragment } from "@fragno-dev/core";
    import { defineFragmentWithDatabase } from "@fragno-dev/db";
    import { mySchema } from "./schema";
    
    const regularLib = defineFragment("regular")
      .withDependencies(({ config }) => ({ dep: dependency1 }))
      .providesService(({ config, deps }) => ({ svc: service1 }));
    
    const dbLib = defineFragmentWithDatabase("db")
      .withDatabase(mySchema)
      .withDependencies(({ config, orm }) => ({ dep: dependency2 }))
      .providesService(({ config, deps, orm }) => ({ svc: service2 }));
  `;

  test("ssr:false - transforms both types", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).not.toContain("dependency1");
    expect(result.code).not.toContain("dependency2");
    expect(result.code).toContain("service1");
    expect(result.code).toContain("service2");
    expect(result.code).not.toContain("mySchema");
    expect(result.code).not.toContain("withDatabase");
    // Should have two no-op functions (withDependencies only)
    const noOpCount = (result.code.match(/withDependencies\(\(\) => \{\}\)/g) || []).length;
    expect(noOpCount).toBe(2);
    expect(result.code).toContain('defineFragment("regular")');
    expect(result.code).toContain('defineFragment("db")');
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
      .providesService(({ config, deps, orm }) => ({ svc: service }));
  `;

  test("ssr:false - handles separated chaining", () => {
    const result = transform(source, "", { ssr: false });
    // mySchema import will still be there, just not used in withDatabase
    expect(result.code).not.toContain("dependency");
    expect(result.code).toContain("service");
    expect(result.code).not.toContain("withDatabase");
    expect(result.code).toContain(".withDependencies(() => {})");
    expect(result.code).toContain('defineFragment("mylib")');
  });
});

describe("schema utility function transformation", () => {
  const source = dedent`
    import { column, idColumn, schema } from "@fragno-dev/db/schema";
    import { defineFragmentWithDatabase } from "@fragno-dev/db";

    export const noteSchema = schema("note", (s) => {
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

  test("ssr:false - keeps schema definition for db/schema imports", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("addTable");
    expect(result.code).toContain("addColumn");
    expect(result.code).toContain("createIndex");
    expect(result.code).not.toContain("withDatabase");
    expect(result.code).toContain('defineFragment("mylib")');
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

    export const mySchema = schema("my", (s) => {
      return s.addTable("users", (t) => t);
    });
    
    const lib = defineFragmentWithDatabase("mylib")
      .withDatabase(mySchema);
  `;

  test("ssr:false - transforms schema from main package", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain('schema("my", s => s)');
    expect(result.code).not.toContain("addTable");
  });
});

describe("multiple schema calls", () => {
  const source = dedent`
    import { schema } from "@fragno-dev/db/schema";
    import { defineFragmentWithDatabase } from "@fragno-dev/db";

    export const schema1 = schema("schema1", (s) => {
      return s.addTable("users", (t) => t);
    });
    
    export const schema2 = schema("schema2", (s) => {
      return s.addTable("posts", (t) => t);
    });
    
    const lib1 = defineFragmentWithDatabase("lib1").withDatabase(schema1);
    const lib2 = defineFragmentWithDatabase("lib2").withDatabase(schema2);
  `;

  test("ssr:false - preserves schema definitions for db/schema imports", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("addTable");
  });
});

describe("schema in separate file scenario", () => {
  const source = dedent`
    import { schema } from "@fragno-dev/db/schema";
    
    export const authSchema = schema("auth", (s) => {
      return s.addTable("users", (t) => {
        return t.addColumn("id", { type: "string" });
      });
    });
  `;

  test("ssr:false - preserves schema definition for db/schema imports", () => {
    const result = transform(source, "", { ssr: false });
    expect(result.code).toContain("addTable");
    expect(result.code).toContain("addColumn");
  });

  test("ssr:true - keeps original schema implementation", () => {
    const result = transform(source, "", { ssr: true });
    expect(result.code).toContain("addTable");
    expect(result.code).toContain("addColumn");
  });
});

describe("defineFragmentWithDatabase replacement with defineFragment", () => {
  describe("basic replacement without existing defineFragment import", () => {
    const source = dedent`
      import { defineFragmentWithDatabase } from "@fragno-dev/db";
      import { mySchema } from "./schema";
      
      const lib = defineFragmentWithDatabase("mylib")
        .withDatabase(mySchema)
        .providesService(({ orm }) => ({
          getUsers: () => orm.find("users", (b) => b)
        }));
    `;

    test("ssr:false - replaces with defineFragment and removes withDatabase", () => {
      const result = transform(source, "", { ssr: false });

      // Should import defineFragment from @fragno-dev/core
      expect(result.code).toContain('import { defineFragment } from "@fragno-dev/core"');

      // Should replace defineFragmentWithDatabase with defineFragment
      expect(result.code).toContain('defineFragment("mylib")');

      // Should NOT have withDatabase call
      expect(result.code).not.toContain("withDatabase");

      // Should have providesService preserved
      expect(result.code).toContain("providesService((");
      expect(result.code).toContain("orm");

      // Should keep orm usage in services
      expect(result.code).toContain("orm.find");
    });

    test("ssr:true - keeps original code", () => {
      const result = transform(source, "", { ssr: true });
      expect(result.code).toContain("defineFragmentWithDatabase");
      expect(result.code).toContain("withDatabase");
      expect(result.code).toContain("mySchema");
      expect(result.code).toContain("orm.find");
    });
  });

  describe("with existing defineFragment import", () => {
    const source = dedent`
      import { defineFragment } from "@fragno-dev/core";
      import { defineFragmentWithDatabase } from "@fragno-dev/db";
      import { mySchema } from "./schema";
      
      const lib1 = defineFragment("lib1")
        .providesService(() => ({ svc: service1 }));
      
      const lib2 = defineFragmentWithDatabase("lib2")
        .withDatabase(mySchema)
        .providesService(({ orm }) => ({ svc: service2 }));
    `;

    test("ssr:false - reuses existing defineFragment import", () => {
      const result = transform(source, "", { ssr: false });

      // Should have defineFragment import (only once)
      const importCount = (result.code.match(/import { defineFragment }/g) || []).length;
      expect(importCount).toBe(1);

      // Both should use defineFragment
      expect(result.code).toContain('defineFragment("lib1")');
      expect(result.code).toContain('defineFragment("lib2")');

      // Should not have withDatabase
      expect(result.code).not.toContain("withDatabase");
    });
  });

  describe("withDatabase followed by withDependencies", () => {
    const source = dedent`
      import { defineFragmentWithDatabase } from "@fragno-dev/db";
      import { mySchema } from "./schema";
      
      const lib = defineFragmentWithDatabase("mylib")
        .withDatabase(mySchema)
        .withDependencies(({ config, orm }) => ({
          api: createApi(config.apiUrl)
        }))
        .providesService(({ config, deps, orm }) => ({
          userService: new UserService(orm, deps.api)
        }));
    `;

    test("ssr:false - removes withDatabase and transforms other methods", () => {
      const result = transform(source, "", { ssr: false });

      expect(result.code).toContain('defineFragment("mylib")');
      expect(result.code).not.toContain("withDatabase");
      expect(result.code).toContain("withDependencies(() => {})");
      expect(result.code).toContain("providesService((");
      expect(result.code).toContain("userService");
      expect(result.code).not.toContain("createApi");
      expect(result.code).toContain("UserService");
    });
  });

  describe("withDatabase only", () => {
    const source = dedent`
      import { defineFragmentWithDatabase } from "@fragno-dev/db";
      import { mySchema } from "./schema";
      
      const lib = defineFragmentWithDatabase("mylib")
        .withDatabase(mySchema);
    `;

    test("ssr:false - removes withDatabase entirely", () => {
      const result = transform(source, "", { ssr: false });

      expect(result.code).toContain('defineFragment("mylib")');
      expect(result.code).not.toContain("withDatabase");
      expect(result.code).not.toContain("mySchema");

      // Should not have any method calls after defineFragment
      expect(result.code).toMatch(/defineFragment\("mylib"\);?$/m);
    });
  });

  describe("aliased defineFragmentWithDatabase import", () => {
    const source = dedent`
      import { defineFragmentWithDatabase as defineDbFrag } from "@fragno-dev/db";
      import { mySchema } from "./schema";
      
      const lib = defineDbFrag("mylib")
        .withDatabase(mySchema)
        .providesService(({ orm }) => ({ svc: service }));
    `;

    test("ssr:false - handles aliased imports", () => {
      const result = transform(source, "", { ssr: false });

      expect(result.code).toContain('import { defineFragment } from "@fragno-dev/core"');
      expect(result.code).toContain('defineFragment("mylib")');
      expect(result.code).not.toContain("withDatabase");
    });
  });

  describe("multiple defineFragmentWithDatabase calls", () => {
    const source = dedent`
      import { defineFragmentWithDatabase } from "@fragno-dev/db";
      import { schema1, schema2 } from "./schemas";
      
      const lib1 = defineFragmentWithDatabase("lib1")
        .withDatabase(schema1)
        .providesService(({ orm }) => ({ svc1: service1 }));
      
      const lib2 = defineFragmentWithDatabase("lib2")
        .withDatabase(schema2)
        .providesService(({ orm }) => ({ svc2: service2 }));
    `;

    test("ssr:false - transforms all calls", () => {
      const result = transform(source, "", { ssr: false });

      expect(result.code).toContain('defineFragment("lib1")');
      expect(result.code).toContain('defineFragment("lib2")');
      expect(result.code).not.toContain("withDatabase");
      expect(result.code).not.toContain("schema1");
      expect(result.code).not.toContain("schema2");
    });
  });

  describe("stored in variable then chained", () => {
    const source = dedent`
      import { defineFragmentWithDatabase } from "@fragno-dev/db";
      import { mySchema } from "./schema";
      
      const baseLib = defineFragmentWithDatabase("mylib");
      const withDb = baseLib.withDatabase(mySchema);
      const fullLib = withDb.providesService(({ orm }) => ({ svc: service }));
    `;

    test("ssr:false - handles separated chaining", () => {
      const result = transform(source, "", { ssr: false });

      expect(result.code).toContain('defineFragment("mylib")');
      expect(result.code).not.toContain("withDatabase");
      // mySchema import will still be there, just not used in withDatabase
    });
  });

  describe("combined with schema transformation", () => {
    const source = dedent`
      import { schema } from "@fragno-dev/db/schema";
      import { defineFragmentWithDatabase } from "@fragno-dev/db";

      export const noteSchema = schema("note", (s) => {
        return s.addTable("note", (t) => {
          return t.addColumn("id", { type: "string" });
        });
      });
      
      const lib = defineFragmentWithDatabase("mylib")
        .withDatabase(noteSchema)
        .providesService(({ orm }) => ({
          createNote: async (note) => {
            const id = await orm.create("note", note);
            return { ...note, id };
          },
        }));
    `;

    test("ssr:false - keeps db/schema definition and transforms defineFragmentWithDatabase", () => {
      const result = transform(source, "", { ssr: false });

      // Schema should be preserved for db/schema imports
      expect(result.code).toContain("addTable");

      // defineFragmentWithDatabase should be replaced
      expect(result.code).toContain('defineFragment("mylib")');
      expect(result.code).not.toContain("withDatabase");
      // noteSchema variable declaration will still be there, just transformed
      expect(result.code).toContain("noteSchema");

      // providesService should be transformed
      expect(result.code).toContain("providesService((");
      expect(result.code).toContain("orm.create");
    });
  });

  describe("mixed defineFragment and defineFragmentWithDatabase", () => {
    const source = dedent`
      import { defineFragment } from "@fragno-dev/core";
      import { defineFragmentWithDatabase } from "@fragno-dev/db";
      import { mySchema } from "./schema";
      
      const regularLib = defineFragment("regular")
        .withDependencies(({ config }) => ({ dep: dependency1 }))
        .providesService(({ deps }) => ({ svc: service1 }));
      
      const dbLib = defineFragmentWithDatabase("db")
        .withDatabase(mySchema)
        .withDependencies(({ config, orm }) => ({ dep: dependency2 }))
        .providesService(({ deps, orm }) => ({ svc: service2 }));
    `;

    test("ssr:false - transforms both correctly", () => {
      const result = transform(source, "", { ssr: false });

      // Both should use defineFragment
      expect(result.code).toContain('defineFragment("regular")');
      expect(result.code).toContain('defineFragment("db")');

      // withDatabase should be removed from dbLib
      expect(result.code).not.toContain("withDatabase");
      expect(result.code).not.toContain("mySchema");

      // Both should have transformed methods
      const noOpCount = (result.code.match(/withDependencies\(\(\) => \{\}\)/g) || []).length;
      expect(noOpCount).toBe(2);
    });
  });
});
