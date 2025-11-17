# Fragment Services

Services in Fragno provide a way to define reusable business logic and expose functionality to users
of your Fragment. Services are also used to share logic between several Fragments.

Note that if the goal is to make your user provide certain functionality, it usually makes more
sense to add a required property to the fragment's config.

```typescript @fragno-imports
import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
import { instantiate } from "@fragno-dev/core/api/fragment-instantiator";
import type { FragnoPublicConfig } from "@fragno-dev/core";
```

## Providing Services

Fragments provide services using `providesService()`. Services can be passed as a direct object or
via a factory function that receives context (`config`, `deps`, `fragnoConfig`, `defineService`).

```typescript @fragno-test:provide-direct-object
// Object syntax is the simplest way to provide base services.
const fragmentDefinition = defineFragment("email-fragment")
  .providesBaseService(() => ({
    sendEmail: async (to: string, subject: string) => {
      // Email sending logic here
    },
  }))
  .build();
```

```typescript @fragno-test:provide-factory-function
// The factory function receives the fragment's `config`, and `deps` (dependencies).
const fragmentDefinition = defineFragment("api-fragment")
  .providesBaseService(({ config }) => ({
    makeRequest: async (endpoint: string) => {
      return { data: "response" };
    },
  }))
  .build();

const instance = instantiate(fragmentDefinition).withOptions({}).build();
expect(instance.services.makeRequest).toBeInstanceOf(Function);
```

### Named vs Unnamed Services

Unnamed services (shown above) are exposed directly on `instance.services` for direct user
consumption. Named services provide better organization and enable fragments to work together via
required services.

```typescript @fragno-test:provide-named-services
// should provide named services
const fragmentDefinition = defineFragment("logger-fragment")
  .providesService("logger", () => ({
    log: (message: string) => console.log(message),
    error: (message: string) => console.error(message),
  }))
  .build();

const instance = instantiate(fragmentDefinition).withOptions({}).build();
expect(instance.services.logger.log).toBeDefined();
expect(instance.services.logger.error).toBeDefined();
```

### Using `defineService` helper method

Use `defineService` when service methods need proper `this` binding. This is particularly important
for database fragments where methods need access to the current unit of work.

```typescript @fragno-test:chaining-services
// should chain multiple service definitions
const fragmentDefinition = defineFragment("multi-service-fragment")
  .providesService("logger", ({ defineService }) =>
    defineService({
      log: (msg: string) => console.log(msg),
    }),
  )
  .providesService("validator", ({ defineService }) =>
    defineService({
      validate: (input: string) => input.length > 0,
    }),
  )
  .build();
```

## Using Services

Fragments specify required services using `usesService`. Services can be marked as optional using
`usesOptionalService`, making them `undefined` if not provided.

```typescript @fragno-test:declaring-required-service
// should require a service from the user
interface IEmailService {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
}

const fragmentDefinition = defineFragment("notification-fragment")
  .usesService<"email", IEmailService>("email")
  .providesBaseService(({ serviceDeps }) => ({
    sendNotification: (to: string, subject: string, body: string) =>
      serviceDeps.email.sendEmail(to, subject, body),
  }))
  .build();

const emailImpl: IEmailService = {
  sendEmail: async (to, subject, body) => {
    // Implementation
  },
};

const instance = instantiate(fragmentDefinition)
  .withServices({ email: emailImpl })
  .withOptions({})
  .build();

expect(instance.services.sendNotification).toBeDefined();
```

### Optional Services

```typescript @fragno-test:optional-service
// should mark a service as optional
interface ILogger {
  log(message: string): void;
}

const fragmentDefinition = defineFragment("app-fragment")
  .usesOptionalService<"logger", ILogger>("logger")
  .providesBaseService(({ serviceDeps }) => ({
    maybeLog: (message: string) => {
      if (serviceDeps.logger) {
        serviceDeps.logger.log(message);
      }
    },
  }))
  .build();

// Can instantiate without providing the service
const instance = instantiate(fragmentDefinition).withOptions({}).build();

expect(instance).toBeDefined();
expect(instance.services.maybeLog).toBeDefined();
```

### Using Services in Provided Services

Used services are available via `serviceDeps` in the factory function context, enabling composition.

```typescript @fragno-test:using-in-provided
// should use external services in provided services
interface IEmailService {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
}

const fragmentDefinition = defineFragment("welcome-fragment")
  .usesService<"email", IEmailService>("email")
  .providesBaseService(({ serviceDeps }) => ({
    sendWelcomeEmail: async (to: string) => {
      await serviceDeps.email.sendEmail(to, "Welcome!", "Welcome to our service!");
    },
  }))
  .build();

const emailImpl: IEmailService = {
  sendEmail: async () => {},
};

const instance = instantiate(fragmentDefinition)
  .withServices({ email: emailImpl })
  .withOptions({})
  .build();

expect(instance.services.sendWelcomeEmail).toBeDefined();
```

### Missing Required Services

```typescript @fragno-test:missing-required-service
// should throw when required service not provided
interface IStorageService {
  save(key: string, value: string): Promise<void>;
}

const fragmentDefinition = defineFragment("storage-fragment")
  .usesService<"storage", IStorageService>("storage")
  .build();

expect(() => {
  instantiate(fragmentDefinition).withOptions({}).build();
}).toThrow("Fragment 'storage-fragment' requires service 'storage' but it was not provided");
```
