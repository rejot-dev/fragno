# Concrete testing

Use these examples when tests should exercise production paths through explicit dependencies,
concrete collaborators, deterministic implementations, and co-located specifications.

## Pass dependencies through visible boundaries

Make infrastructure and nondeterminism explicit in the operation's inputs.

### Positive — Inject operation dependencies

```ts
type RegistrationDependencies = {
  users: UserRepository;
  mail: MailDelivery;
  ids: IdGenerator;
};

export async function registerUser(
  input: RegisterUserInput,
  dependencies: RegistrationDependencies,
) {
  const user = await dependencies.users.insert({
    id: dependencies.ids.next(),
    email: input.email,
  });

  await dependencies.mail.deliver(welcomeMessageFor(user));

  return user;
}
```

The same function runs in production and tests. Assembly decides which concrete implementations
satisfy its contracts.

## Use concrete local implementations

A local implementation should honor the production contract and maintain real state or behavior.

### Positive — Implement the real contract locally

```ts
class MemoryUserRepository implements UserRepository {
  readonly users = new Map<UserId, User>();

  constructor(private readonly databaseClock: Clock) {}

  async insert(input: NewUser): Promise<User> {
    if (this.users.has(input.id)) {
      throw new DuplicateUserError(input.id);
    }

    const user = {
      ...input,
      createdAt: this.databaseClock.now(),
    };

    this.users.set(user.id, user);
    return user;
  }

  async find(id: UserId) {
    return this.users.get(id);
  }
}
```

This implementation can support many tests and development environments. It is more valuable than a
per-test object programmed to return a particular answer.

## Control nondeterminism with implementations

Clocks and identifier generators should remain ordinary dependencies at the boundary that owns them.
An application clock belongs to operations that own a domain decision. A database clock belongs to
the repository or adapter that assigns persistence timestamps and evaluates database-coordinated
time invariants.

### Positive — Supply deterministic implementations to the owning boundary

```ts
const applicationClock = new FixedClock(new Date("2026-01-15T12:00:00Z"));
const databaseClock = new FixedClock(new Date("2026-01-15T12:00:05Z"));
const ids = new SequenceIdGenerator([userId("user-1")]);

const users = new MemoryUserRepository(databaseClock);
const trial = beginTrial({ plan, startsAt: applicationClock.now() });
```

These implementations control nondeterminism without making the application clock authoritative for
database-owned values. Production database adapters should use database time for persisted lifecycle
timestamps, scheduling, leases, and other state coordinated through the database.

## Assert observable behavior

Exercise the public operation and inspect the concrete collaborators' resulting state.

### Positive — Assert observable state

```ts
const databaseClock = new FixedClock(new Date("2026-01-15T12:00:05Z"));
const users = new MemoryUserRepository(databaseClock);
const mail = new MemoryMailDelivery();

const user = await registerUser(input, { users, mail, ids });

expect(await users.find(user.id)).toEqual(user);
expect(mail.deliveries).toContainEqual(welcomeMessageFor(user));
```

The test verifies behavior instead of asserting which private helper calls happened.

## Keep infrastructure behind small adapters

Wrap external SDKs and runtime APIs in narrow production adapters, then test domain behavior with
another concrete implementation of the same contract.

### Positive — Isolate infrastructure in an adapter

```ts
class ProviderMailDelivery implements MailDelivery {
  constructor(private readonly provider: MailProviderClient) {}

  async deliver(message: MailMessage) {
    await this.provider.send({
      to: message.recipient,
      subject: message.subject,
      text: message.body,
    });
  }
}
```

Adapter integration tests can exercise the actual provider sandbox, local server, database, or
runtime emulator at the infrastructure boundary.

## Co-locate specifications

Place tests beside the source whose behavior they specify.

### Positive — Keep specifications beside source

```text
registration.ts
registration.test.ts
user-repository.ts
user-repository.test.ts
```

A moved or deleted implementation carries its tests with it, and nearby tests make the contract
discoverable while editing.

## Review criterion

Code is concretely testable when dependencies are explicit, deterministic implementations control
time and identity at the boundaries that own them, database time remains owned by storage adapters,
local implementations preserve real contract behavior, tests exercise public operations,
infrastructure adapters receive integration coverage, and source files sit beside their tests.
