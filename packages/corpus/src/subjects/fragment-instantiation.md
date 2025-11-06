# Fragment Instantiation

Fragno provides the `instantiateFragment` function, which uses a builder pattern to help you and
your user create Fragments.

```typescript @fragno-imports
import {
  defineFragment,
  createFragment,
  instantiateFragment,
  defineRoute,
  type FragnoPublicConfig,
} from "@fragno-dev/core";
import { z } from "zod";
```

## Basic Usage

```typescript @fragno-test:builder-basic
/** Fragment specific config */
interface AppConfig {
  apiKey: string;
}

const fragment = defineFragment<AppConfig>("api-fragment");

// User-facing fragment creator function. This is the main integration point for users of your fragment.
export function createMyFragment(config: AppConfig, options: FragnoPublicConfig = {}) {
  return (
    instantiateFragment(fragment)
      .withConfig(config)
      /** Options are passed to Fragno internally */
      .withOptions(options)
      .build()
  );
}

// What your user will call to instantiate the fragment:
const instance = createMyFragment({ apiKey: "my-secret-key" }, { mountRoute: "/api/v1" });

expect(instance.config.name).toBe("api-fragment");
expect(instance.mountRoute).toBe("/api/v1");
```

Use `withConfig` to provide the fragment's configuration and `withOptions` to set options like
`mountRoute`.

### Builder with Routes

Also see the `defining-routes` subject.

```typescript @fragno-test:builder-with-routes
// should add routes using withRoutes
const fragment = defineFragment<{}>("routes-fragment");

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

const instance = instantiateFragment(fragment).withConfig({}).withRoutes([route1, route2]).build();

expect(instance.config.routes).toHaveLength(2);
expect(instance.config.routes[0].path).toBe("/hello");
expect(instance.config.routes[1].path).toBe("/goodbye");
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
  .usesService<"logger", ILogger>("logger");

const loggerImpl: ILogger = {
  log: (msg) => console.log(msg),
};

const instance = instantiateFragment(fragment)
  .withConfig({ apiKey: "my-key" })
  .withServices({ logger: loggerImpl })
  .build();

expect(instance.deps.client.key).toBe("my-key");
expect(instance.services.logger).toBeDefined();
```

Use `withDependencies` to create dependencies from config, and `withServices` to provide required
services.
