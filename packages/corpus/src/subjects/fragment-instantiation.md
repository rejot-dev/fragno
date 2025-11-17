# Fragment Instantiation

Fragno provides the `instantiate` function, which uses a builder pattern to help you and your user
create Fragments.

```typescript @fragno-imports
import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
import { instantiate } from "@fragno-dev/core/api/fragment-instantiator";
import { defineRoute } from "@fragno-dev/core/api/route";
import type { FragnoPublicConfig } from "@fragno-dev/core";
import { z } from "zod";
```

## Basic Usage

```typescript @fragno-test:builder-basic
/** Fragment specific config */
interface AppConfig {
  apiKey: string;
}

const fragmentDefinition = defineFragment<AppConfig>("api-fragment").build();

// User-facing fragment creator function. This is the main integration point for users of your fragment.
export function createMyFragment(config: AppConfig, options: FragnoPublicConfig = {}) {
  return (
    instantiate(fragmentDefinition)
      .withConfig(config)
      /** Options are passed to Fragno internally */
      .withOptions(options)
      .build()
  );
}

// What your user will call to instantiate the fragment:
const instance = createMyFragment({ apiKey: "my-secret-key" }, { mountRoute: "/api/v1" });

expect(instance.name).toBe("api-fragment");
expect(instance.mountRoute).toBe("/api/v1");
```

Use `withConfig` to provide the fragment's configuration and `withOptions` to set options like
`mountRoute`.

### Builder with Routes

Also see the `defining-routes` subject.

```typescript @fragno-test:builder-with-routes
// should add routes using withRoutes
const fragmentDefinition = defineFragment("routes-fragment").build();

const route1 = defineRoute({
  method: "GET",
  path: "/hello",
  outputSchema: z.string(),
  handler: async (_, { json }) => json("Hello"),
});

const route2 = defineRoute({
  method: "GET",
  path: "/goodbye",
  outputSchema: z.string(),
  handler: async (_, { json }) => json("Goodbye"),
});

const instance = instantiate(fragmentDefinition)
  .withRoutes([route1, route2])
  .withOptions({})
  .build();

expect(instance.routes).toHaveLength(2);
expect(instance.routes[0].path).toBe("/hello");
expect(instance.routes[1].path).toBe("/goodbye");
```

Routes can be added as an array using `withRoutes`.

### Builder with Services and Dependencies

Also see the `fragment-services` subject.

```typescript @fragno-test:builder-with-services
// should provide services and dependencies
interface AppConfig {
  apiKey: string;
}

interface ILogger {
  log(message: string): void;
}

const fragment = defineFragment<AppConfig>("service-fragment")
  .withDependencies(({ config }) => ({
    client: { key: config.apiKey },
  }))
  .usesService<"logger", ILogger>("logger")
  .build();

const loggerImpl: ILogger = {
  log: (msg) => console.log(msg),
};

const instance = instantiate(fragment)
  .withConfig({ apiKey: "my-key" })
  .withServices({ logger: loggerImpl })
  .withOptions({})
  .build();

expect(instance.$internal.deps.client.key).toBe("my-key");
```

Use `withDependencies` to create dependencies from config, and `withServices` to provide required
services.
