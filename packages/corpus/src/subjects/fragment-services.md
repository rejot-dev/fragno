# Fragment Services

Services in Fragno provide a way to define reusable business logic and expose functionality to users
of your Fragment. Services are also used to share logic between several Fragments.

Note that if the goal is to make your user provide certain functionality, it usually makes more
sense to add a required property to the fragment's config.

```typescript @fragno-imports
import { defineFragment, instantiateFragment } from "@fragno-dev/core";
import type { FragnoPublicConfig } from "@fragno-dev/core";
```

## Providing Services

Fragments provide services using `providesService()`. Services can be passed as a direct object or
via a factory function that receives context (`config`, `deps`, `fragnoConfig`, `defineService`).

```typescript @fragno-test:provide-direct-object
// Object syntax is the simplest way to provide services.
const fragment = defineFragment<{}>("email-fragment").providesService({
  sendEmail: async (to: string, subject: string) => {
    // Email sending logic here
  },
});
```

```typescript @fragno-test:provide-factory-function
// The factory function receives the fragment's `config`, and `deps` (dependencies).
const fragment = defineFragment<{}>("api-fragment").providesService(({ config }) => ({
  makeRequest: async (endpoint: string) => {
    return { data: "response" };
  },
}));

const instance = instantiateFragment(fragment).withConfig({}).build();
expect(instance.services.makeRequest).toBeInstanceOf(Function);
```

### Named vs Unnamed Services

Unnamed services (shown above) are exposed directly on `instance.services` for direct user
consumption. Named services provide better organization and enable fragments to work together via
required services.

```typescript @fragno-test:provide-named-services
// should provide named services
const fragment = defineFragment<{}>("logger-fragment").providesService(
  "logger",
  ({ defineService }) =>
    defineService({
      log: (message: string) => console.log(message),
      error: (message: string) => console.error(message),
    }),
);

const instance = instantiateFragment(fragment).withConfig({}).build();
expect(instance.services.logger.log).toBeDefined();
expect(instance.services.logger.error).toBeDefined();
```

### Using `defineService` helper method

Use `defineService` when service methods need proper `this` binding. This is particularly important
for database fragments where methods need access to the current unit of work.

```typescript @fragno-test:chaining-services
// should chain multiple service definitions
const fragment = defineFragment<{}>("multi-service-fragment")
  .providesService("logger", ({ defineService }) =>
    defineService({
      log: (msg: string) => console.log(msg),
    }),
  )
  .providesService("validator", ({ defineService }) =>
    defineService({
      validate: (input: string) => input.length > 0,
    }),
  );
```

## Using Services

Fragments specify required services using `usesService`. Services can be marked as optional with
`{ optional: true }`, making them `undefined` if not provided.

```typescript @fragno-test:declaring-required-service
// should require a service from the user
interface IEmailService {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
}

const fragment = defineFragment<{}>("notification-fragment").usesService<"email", IEmailService>(
  "email",
);

const emailImpl: IEmailService = {
  sendEmail: async (to, subject, body) => {
    // Implementation
  },
};

const instance = instantiateFragment(fragment)
  .withConfig({})
  .withServices({ email: emailImpl })
  .build();

expect(instance.services.email).toBeDefined();
expect(instance.services.email.sendEmail).toBeDefined();
```

### Optional Services

```typescript @fragno-test:optional-service
// should mark a service as optional
interface ILogger {
  log(message: string): void;
}

const fragment = defineFragment<{}>("app-fragment").usesService<"logger", ILogger>("logger", {
  optional: true,
});

// Can instantiate without providing the service
const instance = instantiateFragment(fragment).withConfig({}).build();

expect(instance).toBeDefined();
// logger will be undefined
expect(instance.services.logger).toBeUndefined();
```

### Using Services in Provided Services

Used services are available via `deps` in the factory function context, enabling composition.

```typescript @fragno-test:using-in-provided
// should use external services in provided services
interface IEmailService {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
}

const fragment = defineFragment<{}>("welcome-fragment")
  .usesService<"email", IEmailService>("email")
  .providesService(({ deps }) => ({
    sendWelcomeEmail: async (to: string) => {
      await deps.email.sendEmail(to, "Welcome!", "Welcome to our service!");
    },
  }));

const emailImpl: IEmailService = {
  sendEmail: async () => {},
};

const instance = instantiateFragment(fragment)
  .withConfig({})
  .withServices({ email: emailImpl })
  .build();

expect(instance.services.sendWelcomeEmail).toBeDefined();
expect(instance.services.email).toBeDefined();
```

### Missing Required Services

```typescript @fragno-test:missing-required-service
// should throw when required service not provided
interface IStorageService {
  save(key: string, value: string): Promise<void>;
}

const fragment = defineFragment<{}>("storage-fragment").usesService<"storage", IStorageService>(
  "storage",
);

expect(() => {
  instantiateFragment(fragment).withConfig({}).build();
}).toThrow("Fragment 'storage-fragment' requires service 'storage' but it was not provided");
```
